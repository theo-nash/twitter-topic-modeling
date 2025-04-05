// src/TwitterConnector.ts
import { elizaLogger } from "@elizaos/core";
import { GuidedTopicManager } from "./GuidedTopicManager";

// Example Twitter data structure
export interface Tweet {
    id: string;
    text: string;
    createdAt: Date;
    authorId: string;
    authorName: string;
    hashtags: string[];
    mentions: string[];
}

/**
 * Twitter connector that processes tweets and extracts topics
 */
export class TwitterConnector {
    private topicManager: GuidedTopicManager;
    private processedTweetIds: Set<string> = new Set();

    constructor(topicManager: GuidedTopicManager) {
        this.topicManager = topicManager;
    }

    /**
     * Process a batch of tweets for topic extraction
     */
    async processTweets(tweets: Tweet[]): Promise<Map<string, string[]>> {
        const results = new Map<string, string[]>();

        // Filter out already processed tweets
        const newTweets = tweets.filter(tweet => !this.processedTweetIds.has(tweet.id));

        if (newTweets.length === 0) {
            return results;
        }

        // Process each tweet
        for (const tweet of newTweets) {
            try {
                // Mark as processed
                this.processedTweetIds.add(tweet.id);

                // First, extract topics from hashtags
                const hashtagTopics = tweet.hashtags.map(hashtag =>
                    this.formatHashtag(hashtag)
                );

                // Then extract topics from text
                const textTopics = await this.topicManager.discoverTopicsFromText(tweet.text);

                // Combine and unique-ify topics
                const allTopics = [...new Set([...hashtagTopics, ...textTopics])];

                // Track this observation
                this.topicManager.trackObservation(allTopics);

                // Store results
                results.set(tweet.id, allTopics);
            } catch (error) {
                elizaLogger.error(`[TwitterConnector] Error processing tweet ${tweet.id}: ${error}`);
            }
        }

        return results;
    }

    /**
     * Format a hashtag to be a proper topic
     */
    private formatHashtag(hashtag: string): string {
        // Remove the # symbol
        let formatted = hashtag.startsWith('#') ? hashtag.substring(1) : hashtag;

        // Split camelCase or PascalCase hashtags
        formatted = formatted.replace(/([a-z])([A-Z])/g, '$1 $2');

        // Normalize through the topic manager
        return this.topicManager.normalizeTopic(formatted);
    }

    /**
     * Get active topics from recent tweets
     */
    getActiveTopics(minInterest: number = 0.2, limit: number = 20): {
        topic: string;
        interestLevel: number;
        relatedTopics: string[];
    }[] {
        // Get active topics
        const activeTopics = this.topicManager.getActiveTopics(minInterest);

        // Get metadata for each topic
        const topicsWithMetadata = activeTopics
            .map(topic => {
                const metadata = this.topicManager.getTopicMetadata(topic);
                if (!metadata) return null;

                return {
                    topic,
                    interestLevel: metadata.interestLevel,
                    relatedTopics: this.topicManager.getRelatedTopics(topic, 5)
                };
            })
            .filter(topic => topic !== null) as {
                topic: string;
                interestLevel: number;
                relatedTopics: string[];
            }[];

        // Limit results
        return topicsWithMetadata.slice(0, limit);
    }
}