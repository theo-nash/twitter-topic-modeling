// src/TopicManager.ts
import { elizaLogger, generateText, ModelClass, type IAgentRuntime } from "@elizaos/core";

/**
 * Metadata for tracking topic information
 */
export interface TopicMetadata {
    isCore: boolean;              // Whether this is a core topic for the agent
    interestLevel: number;        // 0.0 to 1.0, dynamically calculated
    discoveryDate: number;        // When this topic was first discovered
    lastUpdated: number;          // Last time this topic was encountered
    observationCount: number;     // How many observations mention this topic
    mentionCount: number;         // How many times mentioned in all observations
    relatedTopics: string[];      // List of related topic IDs
}

/**
 * Topic similarity assessment result
 */
interface TopicSimilarityResult {
    topic: string;
    similarity: number;  // 0.0 to 1.0
}

/**
 * Manages the discovery, normalization, and tracking of topics
 */
export class TopicManager {
    protected runtime: IAgentRuntime;
    protected coreTopics: Set<string>;
    protected discoveredTopics: Map<string, TopicMetadata>;
    protected topicRelationships: Map<string, Map<string, number>>;  // topic -> (related topic -> strength)
    protected synonyms: Map<string, string>;  // variant -> canonical
    protected cacheKey = "twitter/world_view/topics";
    protected similarityThreshold = 0.85;  // Threshold for considering topics similar

    /**
     * Creates a new TopicManager
     * 
     * @param runtime The agent runtime
     * @param initialTopics Initial set of core topics
     */
    constructor(runtime: IAgentRuntime, initialTopics: string[] = []) {
        this.runtime = runtime;
        this.coreTopics = new Set();
        this.discoveredTopics = new Map();
        this.topicRelationships = new Map();
        this.synonyms = new Map();

        // Initialize with character topics if available
        const characterTopics = runtime.character?.topics || [];
        const allInitialTopics = [...new Set([...initialTopics, ...characterTopics])];

        // Initialize core topics
        allInitialTopics.forEach(topic => this.addTopic(topic, true));

        // Load saved topics
        this.loadTopics();
    }

    /**
     * Initialize the topic manager
     */
    async initialize(): Promise<void> {
        await this.loadTopics();
        elizaLogger.log(`[TopicManager] Initialized with ${this.coreTopics.size} core topics, ${this.discoveredTopics.size} total topics`);
    }

    /**
     * Add a new topic to the system
     * 
     * @param topic The topic to add
     * @param isCore Whether this is a core topic
     * @returns The normalized topic string
     */
    addTopic(topic: string, isCore: boolean = false): string {
        const normalizedTopic = this.normalizeTopic(topic);

        if (this.discoveredTopics.has(normalizedTopic)) {
            // Update existing topic if needed
            const metadata = this.discoveredTopics.get(normalizedTopic)!;

            if (isCore && !metadata.isCore) {
                metadata.isCore = true;
                this.coreTopics.add(normalizedTopic);
            }

            return normalizedTopic;
        }

        // Add new topic
        this.discoveredTopics.set(normalizedTopic, {
            isCore,
            interestLevel: isCore ? 1.0 : 0.5,
            discoveryDate: Date.now(),
            lastUpdated: Date.now(),
            observationCount: 0,
            mentionCount: 0,
            relatedTopics: []
        });

        // Add to core topics if applicable
        if (isCore) {
            this.coreTopics.add(normalizedTopic);
        }

        // Initialize relationships map
        this.topicRelationships.set(normalizedTopic, new Map());

        return normalizedTopic;
    }

    /**
     * Normalize a topic string
     * 
     * @param topic Topic string to normalize
     * @returns Normalized topic string
     */
    normalizeTopic(topic: string): string {
        // Basic normalization rules:
        // 1. Convert to lowercase
        // 2. Remove leading/trailing whitespace
        // 3. Replace multiple spaces with a single space
        // 4. Remove special characters except spaces
        // 5. Remove stop words

        // Step 1-3
        let normalized = topic.toLowerCase().trim().replace(/\s+/g, ' ');

        // Step 4
        normalized = normalized.replace(/[^\w\s]/g, '');

        // Step 5: Remove common stop words that don't add meaning
        const stopWords = ['a', 'an', 'the', 'and', 'or', 'but', 'of', 'for', 'in', 'on', 'at', 'to'];
        let words = normalized.split(' ');

        // Only remove stop words if they're not the only word
        if (words.length > 1) {
            words = words.filter(word => !stopWords.includes(word));
        }

        normalized = words.join(' ');

        return normalized;
    }

    /**
     * Get the canonical form of a topic (resolving synonyms)
     * 
     * @param topic Topic to canonicalize
     * @returns Canonical topic
     */
    getCanonicalTopic(topic: string): string {
        const normalized = this.normalizeTopic(topic);
        return this.synonyms.get(normalized) || normalized;
    }

    /**
     * Check if a topic already exists in the system
     * 
     * @param topic Topic to check
     * @returns Whether the topic exists
     */
    hasTopic(topic: string): boolean {
        const normalized = this.normalizeTopic(topic);
        return this.discoveredTopics.has(normalized) || this.synonyms.has(normalized);
    }

    /**
     * Find a topic similar to the provided one
     * 
     * @param topic Topic to find similarity for
     * @param threshold Similarity threshold (0.0 - 1.0)
     * @returns Similar topic or null if none found
     */
    async findSimilarTopic(topic: string, threshold = this.similarityThreshold): Promise<string | null> {
        const normalized = this.normalizeTopic(topic);

        // Check for exact match first
        if (this.discoveredTopics.has(normalized)) {
            return normalized;
        }

        // Check for synonym
        if (this.synonyms.has(normalized)) {
            return this.synonyms.get(normalized)!;
        }

        // For small topic counts, we can check each one
        if (this.discoveredTopics.size < 100) {
            return this.findSimilarTopicByComparison(normalized, threshold);
        }

        // For larger sets, use LLM to find the closest match
        return this.findSimilarTopicViaLLM(normalized, threshold);
    }

    /**
     * Find similar topic by direct comparison
     */
    private findSimilarTopicByComparison(normalized: string, threshold: number): string | null {
        // Simple word overlap similarity for small topic sets
        const topicWords = new Set(normalized.split(' '));

        let bestMatch: string | null = null;
        let bestSimilarity = 0;

        for (const existingTopic of this.discoveredTopics.keys()) {
            // Skip identical topics
            if (existingTopic === normalized) continue;

            const existingWords = new Set(existingTopic.split(' '));

            // Calculate Jaccard similarity
            const intersection = new Set([...topicWords].filter(word => existingWords.has(word)));
            const union = new Set([...topicWords, ...existingWords]);

            const similarity = intersection.size / union.size;

            if (similarity > bestSimilarity && similarity >= threshold) {
                bestMatch = existingTopic;
                bestSimilarity = similarity;
            }
        }

        return bestMatch;
    }

    /**
     * Find similar topic using LLM
     */
    private async findSimilarTopicViaLLM(normalized: string, threshold: number): Promise<string | null> {
        try {
            // For larger topic sets, use LLM to find the closest match
            const allTopics = Array.from(this.discoveredTopics.keys());

            // Build prompt for LLM
            const prompt = `
            # Topic Similarity Assessment
            
            Find the most similar topic to "${normalized}" from the following list:
            ${allTopics.map(t => `- ${t}`).join('\n')}
            
            ## Response Format
            Return a JSON object with:
            1. "mostSimilar": The most similar topic
            2. "similarity": A number from 0.0 to 1.0 representing similarity
            
            Example:
            {
              "mostSimilar": "example topic",
              "similarity": 0.75
            }
            
            If no topics are similar enough (threshold: ${threshold}), set "mostSimilar" to null.
            `;

            const response = await generateText({
                runtime: this.runtime,
                context: prompt,
                modelClass: ModelClass.SMALL
            });

            // Extract JSON from response
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;

            try {
                const result = JSON.parse(jsonMatch[0]) as {
                    mostSimilar: string | null;
                    similarity: number;
                };

                if (result.mostSimilar && result.similarity >= threshold) {
                    return result.mostSimilar;
                }
            } catch (error) {
                elizaLogger.error(`[TopicManager] Error parsing LLM similarity response: ${error}`);
            }
        } catch (error) {
            elizaLogger.error(`[TopicManager] Error finding similar topic via LLM: ${error}`);
        }

        return null;
    }

    /**
     * Discover potential topics from text content
     * 
     * @param text Text to analyze for topics
     * @returns Array of discovered topics
     */
    async discoverTopicsFromText(text: string): Promise<string[]> {
        try {
            // Extract topics using LLM
            const extractedTopics = await this.extractTopicsViaLLM(text);
            const newTopics: string[] = [];

            for (const topic of extractedTopics) {
                const normalizedTopic = this.normalizeTopic(topic);

                // Skip empty topics
                if (!normalizedTopic) continue;

                // Check if this is a synonym of existing topic
                const similarTopic = await this.findSimilarTopic(normalizedTopic);

                if (similarTopic) {
                    // Add as synonym if similarity is high but not exact
                    if (similarTopic !== normalizedTopic) {
                        this.synonyms.set(normalizedTopic, similarTopic);
                    }

                    // Update the metadata
                    this.updateTopicMetadata(similarTopic);
                } else {
                    // Add as new topic
                    this.addTopic(normalizedTopic);
                    newTopics.push(normalizedTopic);
                }
            }

            // If we added new topics, save them
            if (newTopics.length > 0) {
                await this.saveTopics();
            }

            return newTopics;
        } catch (error) {
            elizaLogger.error(`[TopicManager] Error discovering topics: ${error}`);
            return [];
        }
    }

    /**
     * Extract topics from text using LLM
     * 
     * @param text Text to analyze
     * @returns Array of discovered topics
     */
    private async extractTopicsViaLLM(text: string): Promise<string[]> {
        try {
            // Build context for what constitutes a good topic
            const characterTopics = Array.from(this.coreTopics).slice(0, 5);

            // Create prompt for topic extraction
            const prompt = `
            # Topic Extraction
            
            Extract 1-5 specific topics from the following text. Focus on clear subjects, concepts, or themes.
            
            ## About the Agent
            This agent's core topics include: ${characterTopics.join(', ')}
            
            ## Text to Analyze
            "${text.substring(0, 1000)}"
            
            ## Guidelines
            - Good topics are specific concepts, ideas or domains
            - Topics should be 1-4 words long
            - Avoid generic topics like "news" or "update"
            - Prioritize topics related to the agent's core interests
            - Include emerging topics that seem important
            
            ## Response Format
            Return a JSON array of topics:
            ["topic1", "topic2", "topic3"]
            `;

            const response = await generateText({
                runtime: this.runtime,
                context: prompt,
                modelClass: ModelClass.SMALL
            });

            // Extract JSON array from response
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (!jsonMatch) return [];

            try {
                const topics = JSON.parse(jsonMatch[0]) as string[];
                return topics.filter(topic => topic && topic.trim().length > 0);
            } catch (error) {
                elizaLogger.error(`[TopicManager] Error parsing LLM topic extraction: ${error}`);
                return [];
            }
        } catch (error) {
            elizaLogger.error(`[TopicManager] Error extracting topics via LLM: ${error}`);
            return [];
        }
    }

    /**
     * Track an observation for the given topics
     * 
     * @param topics Array of topics in the observation
     */
    trackObservation(topics: string[]): void {
        const uniqueTopics = new Set(topics.map(t => this.getCanonicalTopic(t)));

        uniqueTopics.forEach(topic => {
            const metadata = this.discoveredTopics.get(topic);

            if (metadata) {
                metadata.observationCount++;
                metadata.mentionCount++;
                metadata.lastUpdated = Date.now();
                this.updateInterestLevel(topic);
            }

            // Update relationships between topics that co-occur
            this.updateTopicRelationships(Array.from(uniqueTopics));
        });
    }

    /**
     * Update the interest level for a topic
     * 
     * @param topic Topic to update
     */
    private updateInterestLevel(topic: string): void {
        const metadata = this.discoveredTopics.get(topic);
        if (!metadata) return;

        // Calculate recency factor (higher for more recent updates)
        const now = Date.now();
        const daysSinceLastUpdate = (now - metadata.lastUpdated) / (1000 * 60 * 60 * 24);
        const recencyFactor = Math.exp(-0.1 * daysSinceLastUpdate); // Exponential decay

        // Calculate frequency factor (higher for more frequent observations)
        const frequencyFactor = Math.min(1.0, metadata.observationCount / 10);

        // Core topics always maintain high interest
        if (metadata.isCore) {
            metadata.interestLevel = Math.max(0.7, 0.3 * recencyFactor + 0.7 * frequencyFactor);
        } else {
            metadata.interestLevel = 0.6 * recencyFactor + 0.4 * frequencyFactor;
        }
    }

    /**
     * Update relationships between co-occurring topics
     * 
     * @param topics Array of co-occurring topics
     */
    private updateTopicRelationships(topics: string[]): void {
        // For each pair of topics, increment their relationship strength
        for (let i = 0; i < topics.length; i++) {
            for (let j = i + 1; j < topics.length; j++) {
                const topic1 = topics[i];
                const topic2 = topics[j];

                this.incrementRelationship(topic1, topic2);
                this.incrementRelationship(topic2, topic1);
            }
        }
    }

    /**
     * Increment the relationship strength between two topics
     */
    protected incrementRelationship(topic1: string, topic2: string): void {
        if (!this.topicRelationships.has(topic1)) {
            this.topicRelationships.set(topic1, new Map());
        }

        const relationships = this.topicRelationships.get(topic1)!;
        const currentStrength = relationships.get(topic2) || 0;
        relationships.set(topic2, currentStrength + 1);

        // Update related topics in metadata
        const metadata = this.discoveredTopics.get(topic1);
        if (metadata && !metadata.relatedTopics.includes(topic2)) {
            metadata.relatedTopics.push(topic2);
        }
    }

    /**
     * Update a topic's metadata
     * 
     * @param topic Topic to update
     */
    protected updateTopicMetadata(topic: string): void {
        const metadata = this.discoveredTopics.get(topic);
        if (!metadata) return;

        metadata.mentionCount++;
        metadata.lastUpdated = Date.now();
        this.updateInterestLevel(topic);
    }

    /**
     * Get all active topics sorted by interest level
     * 
     * @param minInterest Minimum interest level (0.0 to 1.0)
     * @returns Array of topic strings
     */
    getActiveTopics(minInterest: number = 0.2): string[] {
        return Array.from(this.discoveredTopics.entries())
            .filter(([_, metadata]) => metadata.interestLevel >= minInterest)
            .sort((a, b) => b[1].interestLevel - a[1].interestLevel)
            .map(([topic]) => topic);
    }

    /**
     * Get all core topics
     * 
     * @returns Array of core topic strings
     */
    getCoreTopics(): string[] {
        return Array.from(this.coreTopics);
    }

    /**
     * Get related topics for a given topic
     * 
     * @param topic Base topic
     * @param limit Maximum number of related topics to return
     * @returns Array of related topics
     */
    getRelatedTopics(topic: string, limit: number = 5): string[] {
        const canonicalTopic = this.getCanonicalTopic(topic);
        const relationships = this.topicRelationships.get(canonicalTopic);

        if (!relationships) return [];

        return Array.from(relationships.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([relatedTopic]) => relatedTopic);
    }

    /**
     * Get metadata for a specific topic
     * 
     * @param topic Topic to get metadata for
     * @returns Topic metadata or null if not found
     */
    getTopicMetadata(topic: string): TopicMetadata | null {
        const canonicalTopic = this.getCanonicalTopic(topic);
        return this.discoveredTopics.get(canonicalTopic) || null;
    }

    /**
     * Get all topics and their metadata
     * 
     * @returns Map of topics to metadata
     */
    getAllTopics(): Map<string, TopicMetadata> {
        return new Map(this.discoveredTopics);
    }

    /**
     * Merge two topics, treating one as a synonym of the other
     * 
     * @param sourceTopic Topic to merge from
     * @param targetTopic Topic to merge into
     * @returns Whether the merge was successful
     */
    async mergeTopic(sourceTopic: string, targetTopic: string): Promise<boolean> {
        const sourceCanonical = this.getCanonicalTopic(sourceTopic);
        const targetCanonical = this.getCanonicalTopic(targetTopic);

        // Can't merge a topic with itself
        if (sourceCanonical === targetCanonical) {
            return false;
        }

        const sourceMetadata = this.discoveredTopics.get(sourceCanonical);
        const targetMetadata = this.discoveredTopics.get(targetCanonical);

        if (!sourceMetadata || !targetMetadata) {
            return false;
        }

        // Update target metadata with source data
        targetMetadata.observationCount += sourceMetadata.observationCount;
        targetMetadata.mentionCount += sourceMetadata.mentionCount;
        targetMetadata.interestLevel = Math.max(targetMetadata.interestLevel, sourceMetadata.interestLevel);

        // If source is core, make target core too
        if (sourceMetadata.isCore) {
            targetMetadata.isCore = true;
            this.coreTopics.add(targetCanonical);
        }

        // Merge relationships
        const sourceRelationships = this.topicRelationships.get(sourceCanonical);
        const targetRelationships = this.topicRelationships.get(targetCanonical) || new Map();

        if (sourceRelationships) {
            for (const [relatedTopic, strength] of sourceRelationships.entries()) {
                const currentStrength = targetRelationships.get(relatedTopic) || 0;
                targetRelationships.set(relatedTopic, currentStrength + strength);
            }
            this.topicRelationships.set(targetCanonical, targetRelationships);
        }

        // Update related topic lists
        const uniqueRelatedTopics = new Set([...targetMetadata.relatedTopics, ...sourceMetadata.relatedTopics]);
        targetMetadata.relatedTopics = Array.from(uniqueRelatedTopics).filter(t => t !== targetCanonical);

        // Create synonym mapping
        this.synonyms.set(sourceCanonical, targetCanonical);

        // Remove source topic but keep the synonym mapping
        this.discoveredTopics.delete(sourceCanonical);
        this.coreTopics.delete(sourceCanonical);
        this.topicRelationships.delete(sourceCanonical);

        // Update all relationship references to source topic
        for (const relationships of this.topicRelationships.values()) {
            if (relationships.has(sourceCanonical)) {
                const strength = relationships.get(sourceCanonical) || 0;
                const targetStrength = relationships.get(targetCanonical) || 0;
                relationships.set(targetCanonical, strength + targetStrength);
                relationships.delete(sourceCanonical);
            }
        }

        // Save changes
        await this.saveTopics();

        return true;
    }

    /**
     * Find potential topic merges and execute them
     * 
     * @param threshold Similarity threshold for merging
     * @returns Number of topics merged
     */
    async findAndExecuteMerges(threshold: number = 0.9): Promise<number> {
        try {
            // Only run this for reasonable numbers of topics
            if (this.discoveredTopics.size > 1000) {
                elizaLogger.warn("[TopicManager] Too many topics to find merges automatically");
                return 0;
            }

            const topics = Array.from(this.discoveredTopics.keys());
            const mergeCandidates: [string, string, number][] = []; // [source, target, similarity]

            // For each pair of topics, evaluate similarity
            for (let i = 0; i < topics.length; i++) {
                for (let j = i + 1; j < topics.length; j++) {
                    const topic1 = topics[i];
                    const topic2 = topics[j];

                    const similarity = await this.calculateTopicSimilarity(topic1, topic2);

                    if (similarity >= threshold) {
                        mergeCandidates.push([topic1, topic2, similarity]);
                    }
                }
            }

            // Sort by similarity (highest first)
            mergeCandidates.sort((a, b) => b[2] - a[2]);

            // Execute merges
            let mergeCount = 0;
            const processedTopics = new Set<string>();

            for (const [source, target, _] of mergeCandidates) {
                // Skip if either topic has already been processed
                if (processedTopics.has(source) || processedTopics.has(target)) {
                    continue;
                }

                // Choose which topic to keep based on metadata quality
                const sourceMetadata = this.discoveredTopics.get(source)!;
                const targetMetadata = this.discoveredTopics.get(target)!;

                // Prefer core topics
                if (sourceMetadata.isCore && !targetMetadata.isCore) {
                    await this.mergeTopic(target, source);
                    processedTopics.add(target);
                } else if (!sourceMetadata.isCore && targetMetadata.isCore) {
                    await this.mergeTopic(source, target);
                    processedTopics.add(source);
                }
                // Prefer topics with more observations
                else if (sourceMetadata.observationCount > targetMetadata.observationCount) {
                    await this.mergeTopic(target, source);
                    processedTopics.add(target);
                } else {
                    await this.mergeTopic(source, target);
                    processedTopics.add(source);
                }

                mergeCount++;
            }

            return mergeCount;
        } catch (error) {
            elizaLogger.error(`[TopicManager] Error finding and executing merges: ${error}`);
            return 0;
        }
    }

    /**
     * Calculate similarity between two topics
     * 
     * @param topic1 First topic
     * @param topic2 Second topic
     * @returns Similarity score (0.0 to 1.0)
     */
    private async calculateTopicSimilarity(topic1: string, topic2: string): Promise<number> {
        // Simple word overlap for short topics
        const words1 = new Set(topic1.split(' '));
        const words2 = new Set(topic2.split(' '));

        // Calculate Jaccard similarity
        const intersection = new Set([...words1].filter(word => words2.has(word)));
        const union = new Set([...words1, ...words2]);

        // Basic similarity
        let similarity = intersection.size / union.size;

        // If topics are related, boost similarity
        const relationships1 = this.topicRelationships.get(topic1);
        if (relationships1 && relationships1.has(topic2)) {
            const relationshipStrength = Math.min(1.0, relationships1.get(topic2)! / 10);
            similarity = Math.max(similarity, relationshipStrength);
        }

        return similarity;
    }

    /**
     * Generate a topic overview using LLM
     * 
     * @param topic Topic to generate overview for
     * @returns Overview text
     */
    async generateTopicOverview(topic: string): Promise<string> {
        const canonicalTopic = this.getCanonicalTopic(topic);
        const metadata = this.discoveredTopics.get(canonicalTopic);

        if (!metadata) {
            return `No information available about topic "${topic}".`;
        }

        // Get related topics
        const relatedTopics = this.getRelatedTopics(canonicalTopic, 5);

        // Build prompt
        const prompt = `
        # Topic Overview: "${canonicalTopic}"
        
        Generate a brief overview of this topic based on the following information:
        
        ## Topic Metadata
        - Core topic: ${metadata.isCore ? 'Yes' : 'No'}
        - Interest level: ${metadata.interestLevel.toFixed(2)}
        - First discovered: ${new Date(metadata.discoveryDate).toLocaleDateString()}
        - Last updated: ${new Date(metadata.lastUpdated).toLocaleDateString()}
        - Observation count: ${metadata.observationCount}
        - Mention count: ${metadata.mentionCount}
        
        ## Related Topics
        ${relatedTopics.map(t => `- ${t}`).join('\n')}
        
        ## About the Agent
        ${this.runtime.character?.bio || 'An AI assistant interested in various topics.'}
        
        ## Output Requirements
        Write a brief (3-5 sentences) overview of what this topic means to this agent and how it relates to their interests and identity.
        `;

        try {
            const response = await generateText({
                runtime: this.runtime,
                context: prompt,
                modelClass: ModelClass.SMALL
            });

            return response.trim();
        } catch (error) {
            elizaLogger.error(`[TopicManager] Error generating topic overview: ${error}`);
            return `"${canonicalTopic}" is a topic that has been mentioned ${metadata.mentionCount} times.`;
        }
    }

    /**
     * Load topics from cache
     */
    protected async loadTopics() {
        try {
            const cached = await this.runtime.cacheManager.get<{
                coreTopics: string[];
                discoveredTopics: Record<string, TopicMetadata>;
                topicRelationships: Record<string, Record<string, number>>;
                synonyms: Record<string, string>;
            }>(this.cacheKey);

            if (cached) {
                // Restore core topics
                this.coreTopics = new Set(cached.coreTopics);

                // Restore discovered topics
                this.discoveredTopics = new Map(Object.entries(cached.discoveredTopics));

                // Restore topic relationships
                this.topicRelationships = new Map();
                for (const [topic, relations] of Object.entries(cached.topicRelationships)) {
                    this.topicRelationships.set(topic, new Map(Object.entries(relations).map(
                        ([relTopic, strength]) => [relTopic, strength]
                    )));
                }

                // Restore synonyms
                this.synonyms = new Map(Object.entries(cached.synonyms));

                elizaLogger.log(`[TopicManager] Loaded ${this.discoveredTopics.size} topics from cache`);
            }
        } catch (error) {
            elizaLogger.error(`[TopicManager] Error loading topics: ${error}`);
        }
    }

    /**
     * Save topics to cache
     */
    protected async saveTopics() {
        try {
            // Convert relationships map to serializable object
            const relationshipsObj: Record<string, Record<string, number>> = {};
            for (const [topic, relations] of this.topicRelationships.entries()) {
                relationshipsObj[topic] = Object.fromEntries(relations);
            }

            await this.runtime.cacheManager.set(
                this.cacheKey,
                {
                    coreTopics: Array.from(this.coreTopics),
                    discoveredTopics: Object.fromEntries(this.discoveredTopics),
                    topicRelationships: relationshipsObj,
                    synonyms: Object.fromEntries(this.synonyms)
                },
                { expires: Date.now() + (30 * 24 * 60 * 60 * 1000) } // 30 days
            );

            elizaLogger.log(`[TopicManager] Saved ${this.discoveredTopics.size} topics to cache`);
        } catch (error) {
            elizaLogger.error(`[TopicManager] Error saving topics: ${error}`);
        }
    }
}