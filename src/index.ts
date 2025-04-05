// src/index.ts
import * as dotenv from 'dotenv';
import * as path from 'path';
import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import { GuidedTopicManager } from './GuidedTopicManager';
import { TwitterConnector, Tweet } from './TwitterConnector';

// Load environment variables
dotenv.config();

// Sample runtime (replace with actual runtime in your environment)
const mockRuntime = {
    character: {
        topics: ['artificial intelligence', 'data science', 'machine learning'],
        bio: 'An AI assistant interested in technology and science.'
    },
    cacheManager: {
        get: async <T>(key: string) => null as T,
        set: async (key: string, value: any, options?: any) => { }
    }
};

/**
 * Main application to demonstrate the topic modeling system
 */
async function main() {
    try {
        console.log("Starting Twitter Topic Modeling System...");

        // Initialize the topic manager with initial topics
        const initialTopics = [
            'machine learning',
            'artificial intelligence',
            'neural networks',
            'deep learning',
            'natural language processing',
            'computer vision',
            'data science',
            'big data',
            'cloud computing',
            'cybersecurity'
        ];

        // Create model directory
        const modelDir = path.join(__dirname, '..', 'models');

        // Initialize topic manager
        const topicManager = new GuidedTopicManager(mockRuntime as IAgentRuntime, initialTopics, modelDir);
        await topicManager.initialize();

        // Create Twitter connector
        const twitterConnector = new TwitterConnector(topicManager);

        // Sample tweets for testing
        const sampleTweets: Tweet[] = [
            {
                id: '1',
                text: 'Just published my research on how large language models can improve code generation #AI #MachineLearning',
                createdAt: new Date(),
                authorId: 'user1',
                authorName: 'Tech Researcher',
                hashtags: ['#AI', '#MachineLearning'],
                mentions: []
            },
            {
                id: '2',
                text: 'Excited to announce our new framework for training computer vision models with 50% less data requirements! #ComputerVision #DeepLearning',
                createdAt: new Date(),
                authorId: 'user2',
                authorName: 'AI Lab',
                hashtags: ['#ComputerVision', '#DeepLearning'],
                mentions: []
            },
            {
                id: '3',
                text: 'The latest climate models show alarming trends in global warming. We need action now! #ClimateChange #GlobalWarming',
                createdAt: new Date(),
                authorId: 'user3',
                authorName: 'Climate Scientist',
                hashtags: ['#ClimateChange', '#GlobalWarming'],
                mentions: []
            },
            {
                id: '4',
                text: 'Our team just released a new paper on federated learning techniques for privacy-preserving AI models! Check it out at the link below.',
                createdAt: new Date(),
                authorId: 'user4',
                authorName: 'Privacy Researcher',
                hashtags: [],
                mentions: []
            },
            {
                id: '5',
                text: 'Anyone else having issues with the new TensorFlow update? The documentation seems to be incomplete for some of the new features.',
                createdAt: new Date(),
                authorId: 'user5',
                authorName: 'ML Engineer',
                hashtags: [],
                mentions: []
            }
        ];

        // Process the sample tweets
        console.log("Processing sample tweets...");
        const results = await twitterConnector.processTweets(sampleTweets);

        // Print discovered topics for each tweet
        for (const [tweetId, topics] of results.entries()) {
            const tweet = sampleTweets.find(t => t.id === tweetId);
            console.log(`\nTweet: "${tweet?.text}"`);
            console.log(`Discovered topics: ${topics.join(', ')}`);
        }

        // Wait a moment for processing to complete
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Show all active topics
        console.log("\n--- Active Topics ---");
        const activeTopics = twitterConnector.getActiveTopics(0.2);

        for (const topicInfo of activeTopics) {
            console.log(`${topicInfo.topic} (Interest: ${topicInfo.interestLevel.toFixed(2)})`);
            console.log(`Related topics: ${topicInfo.relatedTopics.join(', ')}`);
            console.log('---');
        }

        // Test with a new text to see topic discovery
        console.log("\nTesting topic discovery with new text...");
        const newText = "Researchers have developed a new quantum computing algorithm that significantly outperforms classical methods for optimization problems.";

        const discoveredTopics = await topicManager.discoverTopicsFromText(newText);
        console.log(`New text: "${newText}"`);
        console.log(`Discovered topics: ${discoveredTopics.join(', ')}`);

        // Add a new predefined topic
        console.log("\nAdding a new predefined topic...");
        await topicManager.addPredefinedTopic("quantum computing", ["quantum algorithms", "qubits", "quantum supremacy"]);

        // Try again with the same text
        const updatedTopics = await topicManager.discoverTopicsFromText(newText);
        console.log(`New text (after adding predefined topic): "${newText}"`);
        console.log(`Discovered topics: ${updatedTopics.join(', ')}`);

        console.log("\nTwitter Topic Modeling System demo completed.");
    } catch (error) {
        console.error("Error in main:", error);
    }
}

// Run the main function
main();