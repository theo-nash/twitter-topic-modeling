import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * Detect the best Python executable to use
 */
function detectPythonExecutable(): string {
    // Try a list of common Python executable names
    const pythonCommands = ['python3', 'python', 'py'];

    for (const cmd of pythonCommands) {
        try {
            const result = spawnSync(cmd, ['-c', 'import sys; print(sys.version)']);
            if (result.status === 0) {
                console.log(`Found Python executable: ${cmd}`);
                return cmd;
            }
        } catch (error) {
            // Continue to next command
        }
    }

    // Default to python3
    console.warn('Could not detect Python executable, defaulting to python3');
    return 'python3';
}

/**
 * Set up the Python environment and install the topic service
 */
async function setupPythonService() {
    console.log('Setting up Python environment for Topic Service...');

    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);

        // Find the best Python executable
        const pythonCommand = detectPythonExecutable();
        console.log(`Using Python executable: ${pythonCommand}`);

        // Ensure python directory exists
        const pythonDir = path.join(__dirname, 'python');
        if (!fs.existsSync(pythonDir)) {
            fs.mkdirSync(pythonDir, { recursive: true });
        }

        // Ensure models directory exists
        const modelsDir = path.join(pythonDir, 'models', 'bertopic_model');
        if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir, { recursive: true });
        }

        // Copy the topic service script to the python directory
        const sourceScript = path.join(__dirname, '..', 'src', 'python', 'topic_service.py');
        const targetScript = path.join(pythonDir, 'topic_service.py');

        if (fs.existsSync(sourceScript)) {
            fs.copyFileSync(sourceScript, targetScript);
            console.log(`Copied topic service script to ${targetScript}`);
        } else {
            // Create the topic service script if it doesn't exist
            console.log('Creating topic service script...');
            // Use either the original topic_service.py content or the simplified one
            // For now, we'll use the simplified one since it has fewer dependencies

            const scriptContent = fs.readFileSync(
                path.join(__dirname, '..', 'src', 'python', 'topic_service_fixed.py'),
                'utf8'
            );
            fs.writeFileSync(targetScript, scriptContent);
            console.log(`Created topic service script at ${targetScript}`);
        }

        // Create requirements.txt file with all needed dependencies
        const requirementsPath = path.join(pythonDir, 'requirements.txt');
        const requirements = `
# Basic dependencies
numpy>=1.20.0
scikit-learn>=1.0.0
spacy>=3.0.0
pyzmq>=22.0.0

# BERTopic and its dependencies
bertopic>=0.15.0
sentence-transformers>=2.2.2
hdbscan>=0.8.29
umap-learn>=0.5.3
`;
        fs.writeFileSync(requirementsPath, requirements);

        // Create virtual environment if it doesn't exist
        const venvPath = path.join(pythonDir, 'venv');
        if (!fs.existsSync(venvPath)) {
            console.log('Creating Python virtual environment...');
            try {
                // Use --with-pip to ensure pip is installed
                execSync(`${pythonCommand} -m venv --with-pip ${venvPath}`);

                // Ensure pip is up-to-date within the venv
                const pipExecutable = process.platform === 'win32'
                    ? path.join(venvPath, 'Scripts', 'pip.exe')
                    : path.join(venvPath, 'bin', 'pip');

                console.log('Upgrading pip in virtual environment...');
                execSync(`${pipExecutable} install --upgrade pip`);
            } catch (error) {
                console.error('Failed to create virtual environment. Make sure python3-venv is installed:');
                console.error('sudo apt install python3-venv');
                console.error(error);
                process.exit(1);
            }
        }

        // Determine python path in the virtual environment
        const pythonExecutable = process.platform === 'win32'
            ? path.join(venvPath, 'Scripts', 'python.exe')
            : path.join(venvPath, 'bin', 'python');

        // Install dependencies with extended timeout
        console.log('Installing Python dependencies (this might take a while)...');
        try {
            // Install base dependencies first
            console.log('Installing base dependencies...');
            execSync(`${pythonExecutable} -m pip install --no-cache-dir numpy scikit-learn pyzmq`,
                { stdio: 'inherit', timeout: 120000 }); // 2 minute timeout

            // Install spaCy separately
            console.log('Installing spaCy...');
            execSync(`${pythonExecutable} -m pip install --no-cache-dir spacy`,
                { stdio: 'inherit', timeout: 120000 }); // 2 minute timeout

            // Install spaCy model
            console.log('Installing spaCy model...');
            execSync(`${pythonExecutable} -m spacy download en_core_web_sm`,
                { stdio: 'inherit', timeout: 120000 }); // 2 minute timeout

            // Install sentence-transformers separately
            console.log('Installing sentence-transformers...');
            execSync(`${pythonExecutable} -m pip install --no-cache-dir sentence-transformers`,
                { stdio: 'inherit', timeout: 300000 }); // 5 minute timeout

            // Install hdbscan and umap-learn separately (these might require compilation)
            console.log('Installing hdbscan and umap-learn...');
            try {
                execSync(`${pythonExecutable} -m pip install --no-cache-dir hdbscan umap-learn`,
                    { stdio: 'inherit', timeout: 300000 }); // 5 minute timeout
            } catch (error) {
                console.warn('Warning: Failed to install hdbscan or umap-learn. You might need to install system dependencies:');
                console.warn('sudo apt-get install build-essential python3-dev');
                console.warn('Then try again or install manually.');
            }

            // Finally install BERTopic
            console.log('Installing BERTopic...');
            execSync(`${pythonExecutable} -m pip install --no-cache-dir bertopic`,
                { stdio: 'inherit', timeout: 300000 }); // 5 minute timeout

            console.log('Python dependencies installed successfully');

            // Test imports to verify installation
            console.log('Verifying installations...');
            try {
                const importResult = spawnSync(pythonExecutable, [
                    '-c',
                    'import numpy; import sklearn; import zmq; import spacy; print("Basic dependencies verified")'
                ]);
                console.log(importResult.stdout.toString());

                const bertopicResult = spawnSync(pythonExecutable, [
                    '-c',
                    'try:\n  import bertopic\n  print("BERTopic available")\nexcept ImportError:\n  print("BERTopic not available, will use simplified service")'
                ]);
                console.log(bertopicResult.stdout.toString());
            } catch (error) {
                console.warn('Warning: Error verifying imports. Some packages might not be installed correctly.');
            }

        } catch (error) {
            console.error('Error installing Python dependencies:', error);
            console.error('Attempting to continue with simplified service...');

            // If BERTopic installation fails, use the simplified service
            const simpleScriptContent = fs.readFileSync(
                path.join(__dirname, '..', 'src', 'python', 'topic_service_fixed.py'),
                'utf8'
            );
            fs.writeFileSync(targetScript, simpleScriptContent);
            console.log(`Created simplified topic service script at ${targetScript}`);

            // Ensure simplified dependencies are installed
            try {
                execSync(`${pythonExecutable} -m pip install --no-cache-dir numpy scikit-learn pyzmq spacy`,
                    { stdio: 'inherit', timeout: 120000 });
                execSync(`${pythonExecutable} -m spacy download en_core_web_sm`,
                    { stdio: 'inherit', timeout: 120000 });
            } catch (innerError) {
                console.error('Error installing simplified dependencies:', innerError);
            }
        }

        console.log('Python environment setup completed!');
        console.log(`To manually run the topic service: ${pythonExecutable} ${targetScript}`);

    } catch (error) {
        console.error('Error setting up Python environment:', error);
        process.exit(1);
    }
}

// Run the setup function
setupPythonService();