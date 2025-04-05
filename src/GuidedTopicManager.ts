// src/GuidedTopicManager.ts
import * as fs from 'fs';
import * as path from 'path';
import { PythonShell } from 'python-shell';
import { elizaLogger, generateText, IAgentRuntime, ModelClass } from "@elizaos/core";
import { TopicManager, TopicMetadata } from './TopicManager';
import { PythonServiceClient } from './PythonServiceClient';

/**
 * Topic manager that uses BERTopic with guided topic modeling
 */
export class GuidedTopicManager extends TopicManager {
    private modelPath: string;
    private predefinedTopics: Map<string, string[]> = new Map();
    private topicThreshold: number = 0.65;
    private batchSize: number = 50;
    private textBuffer: string[] = [];
    private processingBatch: boolean = false;
    private pythonClient: PythonServiceClient;

    /**
     * Constructor initializes guided topic manager
     */
    constructor(runtime: IAgentRuntime, initialTopics: string[] = [], modelBasePath: string = './models') {
        super(runtime, initialTopics);

        // Set up model path
        this.modelPath = path.join(modelBasePath, 'bertopic_model');

        // Initialize predefined topics from core topics
        this.initializePredefinedTopics(initialTopics);

        this.pythonClient = new PythonServiceClient(this.modelPath);
    }

    /**
     * Initialize the guided topic manager
     */
    async initialize(): Promise<void> {
        await super.initialize();

        try {
            // Create model directory if it doesn't exist
            if (!fs.existsSync(this.modelPath)) {
                fs.mkdirSync(this.modelPath, { recursive: true });
            }

            // Initialize predefined topics file
            await this.savePredefinedTopics();

            // Start Python service
            await this.pythonClient.start();

            elizaLogger.log("[GuidedTopicManager] Initialization complete");
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Initialization error: ${error}`);
        }
    }


    /**
     * Initialize predefined topics from core topics
     */
    private initializePredefinedTopics(initialTopics: string[]): void {
        // For each core topic, define seed keywords
        initialTopics.forEach(topic => {
            const normalizedTopic = this.normalizeTopic(topic);
            // Start with the topic itself as a keyword
            this.predefinedTopics.set(normalizedTopic, [normalizedTopic]);
        });
    }

    /**
         * Queue text for batch processing
         */
    async queueTextForTopicDiscovery(text: string): Promise<void> {
        this.textBuffer.push(text);

        // Process immediately if we hit batch size
        if (this.textBuffer.length >= this.batchSize && !this.processingBatch) {
            this.processingBatch = true;
            await this.processBatch();
            this.processingBatch = false;
        }
    }

    /**
     * Override the base discoverTopicsFromText method
     */
    async discoverTopicsFromText(text: string): Promise<string[]> {
        try {
            // Queue for batch processing
            await this.queueTextForTopicDiscovery(text);

            // For immediate results, process directly with Python service
            const topicsData = await this.pythonClient.discoverTopics([text]);

            if (!topicsData || topicsData.length === 0 || !topicsData[0]) {
                return [];
            }

            // Process the discovered topics for the single text
            const topics = topicsData[0];
            const discoveredTopics: string[] = [];
            const newTopics: string[] = [];

            for (const topicInfo of topics) {
                // Generate human-readable name
                const normalizedTopic = this.normalizeTopic(topicInfo.topic);

                // Skip empty topics
                if (!normalizedTopic || normalizedTopic.length < 2) continue;

                // If it's a predefined topic, use it directly
                if (topicInfo.is_predefined) {
                    // Update usage statistics
                    this.updateTopicMetadata(normalizedTopic);
                    discoveredTopics.push(normalizedTopic);
                } else {
                    // It's a new topic, check if it's similar to existing ones
                    const similarTopic = await this.findSimilarTopic(normalizedTopic);

                    if (similarTopic) {
                        // Use the existing similar topic
                        this.updateTopicMetadata(similarTopic);
                        discoveredTopics.push(similarTopic);
                    } else if (topicInfo.probability > this.topicThreshold) {
                        // It's a genuinely new topic with high confidence
                        const newTopic = this.addTopic(normalizedTopic);
                        discoveredTopics.push(newTopic);
                        newTopics.push(newTopic);
                    }
                }
            }

            // If we discovered new topics, update the model
            if (newTopics.length > 0) {
                // Add new topics to predefined list for future classification
                for (const topic of newTopics) {
                    if (!this.predefinedTopics.has(topic)) {
                        this.predefinedTopics.set(topic, [topic]);
                    }
                }

                // Save and update
                await this.savePredefinedTopics();
                await this.saveTopics();

                // Update predefined topics in Python service
                this.pythonClient.updatePredefinedTopics(this.predefinedTopics).catch(error => {
                    elizaLogger.error(`[GuidedTopicManager] Error updating predefined topics: ${error}`);
                });
            }

            return discoveredTopics;
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error discovering topics: ${error}`);
            return [];
        }
    }

    /**
     * Process a batch of texts
     */
    private async processBatch(): Promise<void> {
        if (this.textBuffer.length === 0) return;

        try {
            // Get texts to process
            const texts = [...this.textBuffer];
            this.textBuffer = [];

            // Run topic extraction on the batch using Python service
            const topicsPerDoc = await this.pythonClient.discoverTopics(texts);

            // Process the results
            if (!topicsPerDoc || topicsPerDoc.length === 0) {
                return;
            }

            const newTopics: string[] = [];

            // Process each document's topics
            for (let i = 0; i < Math.min(texts.length, topicsPerDoc.length); i++) {
                const topicsForDoc = topicsPerDoc[i] || [];

                for (const topicInfo of topicsForDoc) {
                    const normalizedTopic = this.normalizeTopic(topicInfo.topic);

                    // Skip empty topics
                    if (!normalizedTopic || normalizedTopic.length < 2) continue;

                    // If it's a predefined topic, just update usage
                    if (topicInfo.is_predefined) {
                        this.updateTopicMetadata(normalizedTopic);
                    } else {
                        // It's a new topic, check if it's similar to existing ones
                        const similarTopic = await this.findSimilarTopic(normalizedTopic);

                        if (similarTopic) {
                            // Use the existing similar topic
                            this.updateTopicMetadata(similarTopic);
                        } else if (topicInfo.probability > this.topicThreshold) {
                            // It's a genuinely new topic with high confidence
                            const newTopic = this.addTopic(normalizedTopic);
                            newTopics.push(newTopic);
                        }
                    }
                }
            }

            // If we discovered new topics, update the model
            if (newTopics.length > 0) {
                // Add new topics to predefined list for future classification
                for (const topic of newTopics) {
                    if (!this.predefinedTopics.has(topic)) {
                        this.predefinedTopics.set(topic, [topic]);
                    }
                }

                // Save and update
                await this.savePredefinedTopics();
                await this.saveTopics();

                // Update Python service
                this.pythonClient.updatePredefinedTopics(this.predefinedTopics).catch(error => {
                    elizaLogger.error(`[GuidedTopicManager] Error updating predefined topics: ${error}`);
                });
            }
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error processing batch: ${error}`);
        }
    }

    /**
     * Save predefined topics to file
     */
    private async savePredefinedTopics(): Promise<void> {
        try {
            const topicsJson = JSON.stringify(Object.fromEntries(this.predefinedTopics));
            const topicsPath = path.join(this.modelPath, 'predefined_topics.json');
            fs.writeFileSync(topicsPath, topicsJson);
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error saving predefined topics: ${error}`);
        }
    }

    /**
     * Add a predefined topic with keywords
     */
    async addPredefinedTopic(topic: string, keywords: string[] = []): Promise<void> {
        const normalizedTopic = this.normalizeTopic(topic);

        // Add to core topics
        this.addTopic(normalizedTopic, true);

        // Add to predefined topics for the guided model
        const allKeywords = [normalizedTopic, ...keywords.map(kw => this.normalizeTopic(kw))];
        this.predefinedTopics.set(normalizedTopic, [...new Set(allKeywords)]);

        // Save and update
        await this.savePredefinedTopics();

        // Update the Python service
        try {
            await this.pythonClient.updatePredefinedTopics(this.predefinedTopics);
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error updating predefined topics in Python service: ${error}`);
        }
    }

    /**
     * Add keywords to an existing topic
     */
    async addKeywordsToTopic(topic: string, keywords: string[]): Promise<void> {
        const canonicalTopic = this.getCanonicalTopic(topic);

        if (!this.predefinedTopics.has(canonicalTopic)) {
            // Add if it doesn't exist
            await this.addPredefinedTopic(canonicalTopic, keywords);
            return;
        }

        // Update keywords for existing topic
        const existingKeywords = this.predefinedTopics.get(canonicalTopic) || [];
        const normalizedKeywords = keywords.map(kw => this.normalizeTopic(kw));
        const updatedKeywords = [...new Set([...existingKeywords, ...normalizedKeywords])];

        this.predefinedTopics.set(canonicalTopic, updatedKeywords);

        // Save and update
        await this.savePredefinedTopics();

        // Update the Python service
        try {
            await this.pythonClient.updatePredefinedTopics(this.predefinedTopics);
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error updating keywords in Python service: ${error}`);
        }
    }

    /**
     * Get all predefined topics with their keywords
     */
    getPredefinedTopics(): Map<string, string[]> {
        return new Map(this.predefinedTopics);
    }

    /**
     * Clean up resources
     */
    async shutdown(): Promise<void> {
        try {
            // Stop Python service
            await this.pythonClient.stop();
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error during shutdown: ${error}`);
        }
    }
}