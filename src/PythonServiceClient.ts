// src/PythonServiceClient.ts
import * as zmq from 'zeromq';
import { elizaLogger } from "@elizaos/core";
import * as path from 'path';
import { spawn, ChildProcess, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Topic information returned from the Python service
 */
export interface TopicInfo {
    topic: string;
    keywords: string[];
    is_predefined: boolean;
    probability: number;
    representative_text: string;
}

/**
 * Client for the Python Topic Modeling Service
 */
export class PythonServiceClient {
    private socket: zmq.Request;
    private serviceProcess: ChildProcess | null = null;
    private isConnected: boolean = false;
    private connecting: boolean = false;
    private modelDir: string;
    private pythonExecutable: string;
    private connectionTimeout: number = 10000; // 10 seconds

    /**
     * Create a new Python service client
     * 
     * @param modelDir Directory where models are stored
     * @param pythonExecutable Python executable to use (defaults to auto-detect)
     */
    constructor(modelDir: string, pythonExecutable?: string) {
        this.modelDir = modelDir;
        this.socket = new zmq.Request();
        this.pythonExecutable = pythonExecutable || this.detectPythonExecutable();
    }

    /**
     * Detect the correct Python executable to use
     */
    private detectPythonExecutable(): string {
        // First, try to use Python from the virtual environment (highest priority)
        const venvPython = path.join(__dirname, 'python', 'venv',
            process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');

        if (fs.existsSync(venvPython)) {
            elizaLogger.log(`[PythonServiceClient] Found Python in virtual environment: ${venvPython}`);
            return venvPython;
        }

        // Try a list of common Python executable names
        const pythonCommands = ['python3', 'python', 'py'];

        for (const cmd of pythonCommands) {
            try {
                const result = spawnSync(cmd, ['-c', 'import sys; print(sys.version)']);
                if (result.status === 0) {
                    elizaLogger.log(`[PythonServiceClient] Found Python executable: ${cmd}`);
                    return cmd;
                }
            } catch (error) {
                // Continue to next command
            }
        }

        if (fs.existsSync(venvPython)) {
            elizaLogger.log(`[PythonServiceClient] Found Python in virtual environment: ${venvPython}`);
            return venvPython;
        }

        // Default to python3 and hope for the best
        elizaLogger.warn('[PythonServiceClient] Could not detect Python executable, defaulting to python3');
        return 'python3';
    }

    /**
     * Start the Python service and connect to it
     */
    async start(): Promise<void> {
        if (this.isConnected || this.connecting) return;
        this.connecting = true;

        try {
            // Start Python service if not already running
            await this.startPythonService();

            // Connect to the service
            await this.socket.connect('tcp://127.0.0.1:5555');

            // Check if service is responsive
            const healthCheck = await this.sendRequestWithTimeout({ command: 'health_check' }, this.connectionTimeout);

            if (!healthCheck.model_loaded) {
                throw new Error('Topic model not loaded');
            }

            this.isConnected = true;
            elizaLogger.log('[PythonServiceClient] Connected to Python service');
        } catch (error) {
            elizaLogger.error(`[PythonServiceClient] Start error: ${error}`);
            this.isConnected = false;

            // Kill any lingering process
            if (this.serviceProcess) {
                this.serviceProcess.kill();
                this.serviceProcess = null;
            }

            throw error;
        } finally {
            this.connecting = false;
        }
    }

    /**
     * Start the Python service process
     */
    private async startPythonService(): Promise<void> {
        // Check if service is already running
        try {
            const testSocket = new zmq.Request();
            testSocket.connect('tcp://127.0.0.1:5555');

            const result = await this.sendRequestWithSocket(
                testSocket,
                { command: 'health_check' },
                this.connectionTimeout
            );

            if (result.status === 'success') {
                elizaLogger.log('[PythonServiceClient] Found existing Python service');
                return;
            }
        } catch (error) {
            // Service not running, we'll start it
            elizaLogger.log('[PythonServiceClient] No existing service found, starting new one');
        }

        return new Promise((resolve, reject) => {
            // Determine Python script path
            const scriptPath = path.join(__dirname, 'python', 'topic_service.py');

            // Check if script exists
            if (!fs.existsSync(scriptPath)) {
                elizaLogger.error(`[PythonServiceClient] Python script not found at ${scriptPath}`);
                reject(new Error(`Python script not found at ${scriptPath}`));
                return;
            }

            elizaLogger.log(`[PythonServiceClient] Starting Python service using: ${this.pythonExecutable} ${scriptPath} ${this.modelDir}`);

            // Start the process using the detected Python executable
            this.serviceProcess = spawn(this.pythonExecutable, [scriptPath, this.modelDir], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Set timeout for startup
            const timeout = setTimeout(() => {
                reject(new Error('Timeout starting Python service'));
            }, 60000 * 3); // 3 minutes
            elizaLogger.info(`[PythonServiceClient] Waiting for Python service to start...`);

            // Listen for successful startup message
            this.serviceProcess.stdout?.on('data', (data) => {
                const output = data.toString();
                elizaLogger.log(`[PythonService] ${output}`);

                if (output.includes('Topic modeling service is running')) {
                    clearTimeout(timeout);
                    resolve();
                }
            });

            // Handle errors
            this.serviceProcess.stderr?.on('data', (data) => {
                elizaLogger.error(`[PythonService] ${data.toString()}`);
            });

            this.serviceProcess.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });

            this.serviceProcess.on('exit', (code) => {
                this.serviceProcess = null;
                this.isConnected = false;

                if (code !== 0) {
                    elizaLogger.error(`[PythonServiceClient] Service exited with code ${code}`);
                }
            });
        });
    }

    /**
     * Send a request with timeout using a provided socket
     */
    private async sendRequestWithSocket(
        socket: zmq.Request,
        request: any,
        timeoutMs: number
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Request timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            // Use an async IIFE to handle the async/await operations
            (async () => {
                try {
                    await socket.send(JSON.stringify(request));
                    const response = await socket.receive();
                    clearTimeout(timer);

                    const result = JSON.parse(response.toString());
                    resolve(result);
                } catch (error) {
                    clearTimeout(timer);
                    reject(error);
                }
            })();
        });
    }

    /**
     * Send a request with timeout using the main socket
     */
    private async sendRequestWithTimeout(request: any, timeoutMs: number = 30000): Promise<any> {
        if (!this.isConnected) {
            throw new Error('Not connected to Python service');
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.isConnected = false; // Mark as disconnected on timeout
                reject(new Error(`Request timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            // Use an async IIFE
            (async () => {
                try {
                    await this.socket.send(JSON.stringify(request));
                    const response = await this.socket.receive();
                    clearTimeout(timer);

                    const result = JSON.parse(response.toString());

                    if (result.status === 'error') {
                        reject(new Error(result.error || 'Unknown error'));
                        return;
                    }

                    resolve(result.result);
                } catch (error) {
                    clearTimeout(timer);
                    this.isConnected = false; // Mark as disconnected on error
                    reject(error);
                }
            })();
        });
    }

    /**
     * Perform a health check on the service
     */
    private async performHealthCheck(): Promise<{
        model_loaded: boolean;
        embedding_model_loaded: boolean;
        spacy_loaded: boolean;
    }> {
        const result = await this.sendRequestWithTimeout({ command: 'health_check' });
        return result as any;
    }

    /**
     * Discover topics in a list of texts
     * 
     * @param texts Array of texts to analyze
     * @returns Array of discovered topics for each text
     */
    async discoverTopics(texts: string[]): Promise<TopicInfo[][]> {
        if (!this.isConnected) {
            await this.start();
        }

        return await this.sendRequestWithTimeout({
            command: 'discover_topics',
            texts
        }) as TopicInfo[][];
    }

    /**
     * Update predefined topics in the model
     * 
     * @param topics Map of topic names to keywords
     * @returns Success status
     */
    async updatePredefinedTopics(topics: Map<string, string[]>): Promise<boolean> {
        if (!this.isConnected) {
            await this.start();
        }

        const predefinedTopics: Record<string, string[]> = {};

        for (const [topic, keywords] of topics.entries()) {
            predefinedTopics[topic] = keywords;
        }

        return await this.sendRequestWithTimeout({
            command: 'update_topics',
            predefined_topics: predefinedTopics
        }) as boolean;
    }

    /**
     * Extract named entities from text
     * 
     * @param text Text to analyze
     * @returns Array of extracted entities
     */
    async extractEntities(text: string): Promise<string[]> {
        if (!this.isConnected) {
            await this.start();
        }

        return await this.sendRequestWithTimeout({
            command: 'extract_entities',
            text
        }) as string[];
    }

    /**
     * Stop the client and service
     */
    async stop(): Promise<void> {
        try {
            if (this.isConnected) {
                // Disconnect socket
                await this.socket.disconnect('tcp://127.0.0.1:5555');
            }
        } catch (error) {
            elizaLogger.error(`[PythonServiceClient] Error disconnecting: ${error}`);
        }

        // Kill the service process if we started it
        if (this.serviceProcess) {
            this.serviceProcess.kill();
            this.serviceProcess = null;
        }

        this.isConnected = false;
    }
}