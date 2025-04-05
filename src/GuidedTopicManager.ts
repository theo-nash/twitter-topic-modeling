// src/GuidedTopicManager.ts
import * as fs from 'fs';
import * as path from 'path';
import { PythonShell } from 'python-shell';
import { elizaLogger, generateText, IAgentRuntime, ModelClass } from "@elizaos/core";
import { TopicManager, TopicMetadata } from './TopicManager';

/**
 * Topic manager that uses BERTopic with guided topic modeling
 */
export class GuidedTopicManager extends TopicManager {
    private pythonPath: string = 'python3'; // Update with your Python path if needed
    private modelPath: string;
    private predefinedTopics: Map<string, string[]> = new Map();
    private topicThreshold: number = 0.65;
    private batchSize: number = 50;
    private textBuffer: string[] = [];
    private processingBatch: boolean = false;

    /**
     * Constructor initializes guided topic manager
     */
    constructor(runtime: IAgentRuntime, initialTopics: string[] = [], modelBasePath: string = './models') {
        super(runtime, initialTopics);

        // Set up model path
        this.modelPath = path.join(modelBasePath, 'bertopic_model');

        // Initialize predefined topics from core topics
        this.initializePredefinedTopics(initialTopics);
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

            // Check if Python and BERTopic are available
            await this.checkPythonDependencies();

            // Initialize guided model
            await this.initializeGuidedModel();

            elizaLogger.log("[GuidedTopicManager] Initialization complete");
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Initialization error: ${error}`);
        }
    }

    /**
     * Check if Python and required dependencies are available
     */
    private async checkPythonDependencies(): Promise<void> {
        try {
            // Check Python version
            const pythonVersionResult = await this.runPythonScript(`
import sys
print(f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")
      `);

            elizaLogger.log(`[GuidedTopicManager] ${pythonVersionResult[0]}`);

            // Check BERTopic installation
            try {
                await this.runPythonScript(`
import bertopic
print(f"BERTopic version: {bertopic.__version__}")
        `);
                elizaLogger.log("[GuidedTopicManager] BERTopic is installed");
            } catch (error) {
                elizaLogger.warn("[GuidedTopicManager] BERTopic not found, attempting to install...");

                // Install BERTopic and dependencies
                await this.runPythonScript(`
import sys
import subprocess
subprocess.check_call([sys.executable, "-m", "pip", "install", "bertopic", "sentence-transformers", "spacy"])
subprocess.check_call([sys.executable, "-m", "spacy", "download", "en_core_web_sm"])
print("Installation complete")
        `);

                elizaLogger.log("[GuidedTopicManager] BERTopic installed successfully");
            }
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Python dependency check failed: ${error}`);
            throw new Error("Python dependency check failed. Please ensure Python 3.7+ is installed.");
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
     * Initialize the guided BERTopic model
     */
    private async initializeGuidedModel(): Promise<void> {
        try {
            // Write predefined topics to a file for Python to access
            const topicsJson = JSON.stringify(Object.fromEntries(this.predefinedTopics));
            const topicsPath = path.join(this.modelPath, 'predefined_topics.json');

            fs.writeFileSync(topicsPath, topicsJson);

            // Check if model already exists
            const modelPath = path.join(this.modelPath, 'model.pkl');
            if (fs.existsSync(modelPath)) {
                elizaLogger.log("[GuidedTopicManager] Loading existing BERTopic model");
                return;
            }

            // Initialize a new model with seed topics
            await this.runPythonScript(`
import json
import os
import pickle
import numpy as np
from bertopic import BERTopic
from sentence_transformers import SentenceTransformer

# Load predefined topics
with open('${topicsPath}', 'r') as f:
    predefined_topics = json.load(f)

# Convert to format expected by BERTopic
seed_topic_list = []
for topic_name, keywords in predefined_topics.items():
    seed_topic_list.append((topic_name, keywords))

# Initialize embedding model
embedding_model = SentenceTransformer('all-MiniLM-L6-v2')

# Create guided model with seed topics
model = BERTopic(
    embedding_model=embedding_model,
    min_topic_size=2,
    seed_topic_list=seed_topic_list,
    calculate_probabilities=True
)

# Initialize with a short document to create model structure
docs = ["This is a placeholder document to initialize the model structure."]
topics, probs = model.fit_transform(docs)

# Save the model
os.makedirs('${this.modelPath}', exist_ok=True)
with open('${modelPath}', 'wb') as f:
    pickle.dump(model, f)

print("Guided BERTopic model initialized with predefined topics")
      `);

            elizaLogger.log("[GuidedTopicManager] Initialized guided BERTopic model");
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error initializing guided model: ${error}`);
        }
    }

    /**
  * Run a Python script and get the output with improved error handling
  */
    private async runPythonScript(script: string, options: any = {}): Promise<string[]> {
        try {
            // Use built-in promise API instead of callback pattern
            const fullOptions = {
                mode: 'text',
                pythonPath: this.pythonPath,
                ...options
            };

            const results = await PythonShell.runString(script, fullOptions);
            return results || [];
        } catch (error: any) {
            // Enhanced error logging with Python traceback if available
            if (error.traceback) {
                elizaLogger.error(`[GuidedTopicManager] Python Error Traceback:\n${error.traceback}`);
            }

            // Include command details in error
            const errorMsg = `Python script error (exit code ${error.exitCode || 'unknown'}): ${error.message}`;
            elizaLogger.error(errorMsg);

            throw error; // Re-throw to allow caller to handle
        }
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

            // For immediate results, process directly
            const tempFilePath = path.join(this.modelPath, 'single_text.json');
            fs.writeFileSync(tempFilePath, JSON.stringify([text]));

            // Extract topics with the enhanced method
            const topicsData = await this.extractTopicsWithBERTopic(tempFilePath);

            // Clean up
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }

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

                // Update model asynchronously
                this.updateGuidedModel().catch(error => {
                    elizaLogger.error(`[GuidedTopicManager] Error updating model: ${error}`);
                });
            }

            return discoveredTopics;
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error discovering topics: ${error}`);
            return [];
        }
    }

    /**
     * Extract topics with BERTopic
     */
    private async extractTopicsWithBERTopic(textsFilePath: string): Promise<any[]> {
        try {
            // Run enhanced BERTopic extraction
            const results = await this.runPythonScript(`
import json
import pickle
import numpy as np
import os
from bertopic import BERTopic
import spacy

# Load spaCy for entity recognition
try:
    nlp = spacy.load("en_core_web_sm")
except:
    import sys
    import subprocess
    subprocess.check_call([sys.executable, "-m", "spacy", "download", "en_core_web_sm"])
    nlp = spacy.load("en_core_web_sm")

# Load model
model_path = '${path.join(this.modelPath, 'model.pkl')}'
if not os.path.exists(model_path):
    print("Model not found, initializing new model")
    from sentence_transformers import SentenceTransformer
    embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
    model = BERTopic(embedding_model=embedding_model, min_topic_size=2)
else:
    with open(model_path, 'rb') as f:
        model = pickle.load(f)

# Load texts
with open('${textsFilePath}', 'r') as f:
    texts = json.load(f)

# Function to extract entities from text
def extract_entities(text):
    doc = nlp(text[:1000])  # Limit length for performance
    entities = []
    for ent in doc.ents:
        if ent.label_ in ["ORG", "PERSON", "GPE", "PRODUCT", "WORK_OF_ART", "EVENT"]:
            entities.append(ent.text)
    return entities

# Get topics and probabilities
topics, probs = model.transform(texts)

# Get topic info for each document
all_topics = []

for i, doc_topic in enumerate(topics):
    doc_text = texts[i]
    
    # Extract entities
    entities = extract_entities(doc_text)
    
    if doc_topic == -1:  # No topic assigned
        # Try to use entities if available
        if entities:
            all_topics.append([{
                "topic": entities[0],
                "keywords": entities[:3] if len(entities) > 1 else [entities[0]],
                "is_predefined": False,
                "probability": 0.7,
                "representative_text": doc_text
            }])
        elif probs[i] is not None:
            # Get top topics by probability
            top_indices = np.argsort(probs[i])[-3:]
            topic_info = []
            for idx in top_indices:
                if probs[i][idx] > ${this.topicThreshold}:
                    topic_keywords = model.get_topic(idx)
                    if topic_keywords:  # Ensure we have keywords
                        keywords = [word for word, _ in topic_keywords[:5]]
                        topic_info.append({
                            "topic": " ".join(keywords[:2]),
                            "keywords": keywords,
                            "is_predefined": idx < len(model.topic_labels_) if hasattr(model, 'topic_labels_') else False,
                            "probability": float(probs[i][idx]),
                            "representative_text": doc_text
                        })
            all_topics.append(topic_info)
        else:
            all_topics.append([])
    else:
        # Get topic keywords
        topic_keywords = model.get_topic(doc_topic)
        if not topic_keywords:
            all_topics.append([])
            continue
            
        keywords = [word for word, _ in topic_keywords[:5]]
        
        # Check if any entities match the topic
        matching_entities = []
        for entity in entities:
            if any(keyword.lower() in entity.lower() for keyword in keywords):
                matching_entities.append(entity)
        
        # Use entities if they match, otherwise use keywords
        if matching_entities:
            topic_name = matching_entities[0]
            enhanced_keywords = matching_entities + keywords
        else:
            topic_name = " ".join(keywords[:2])
            enhanced_keywords = keywords
            
        all_topics.append([{
            "topic": topic_name,
            "keywords": enhanced_keywords,
            "is_predefined": doc_topic < len(model.topic_labels_) if hasattr(model, 'topic_labels_') else False,
            "probability": float(probs[i][doc_topic] if probs[i] is not None else 1.0),
            "representative_text": doc_text
        }])

# Output as JSON
print(json.dumps(all_topics))
      `);

            // Parse the output JSON
            if (results.length > 0) {
                try {
                    const jsonLine = results.find(line => line.trim().startsWith('['));
                    if (jsonLine) {
                        return JSON.parse(jsonLine);
                    }
                } catch (error) {
                    elizaLogger.error(`[GuidedTopicManager] Error parsing BERTopic output: ${error}`);
                }
            }

            return [];
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error extracting topics: ${error}`);
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

            // Create a temporary file with texts
            const tempFilePath = path.join(this.modelPath, 'batch_texts.json');
            fs.writeFileSync(tempFilePath, JSON.stringify(texts));

            // Run topic extraction on the batch
            const topicsPerDoc = await this.extractTopicsWithBERTopic(tempFilePath);

            // Clean up
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }

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

                // Update model asynchronously
                this.updateGuidedModel().catch(error => {
                    elizaLogger.error(`[GuidedTopicManager] Error updating model: ${error}`);
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
     * Update the guided model with new predefined topics
     */
    private async updateGuidedModel(): Promise<void> {
        try {
            await this.runPythonScript(`
import json
import pickle
import os
from bertopic import BERTopic

# Load current model
model_path = '${path.join(this.modelPath, 'model.pkl')}'
if not os.path.exists(model_path):
    print("Model not found, cannot update")
    exit(1)

with open(model_path, 'rb') as f:
    model = pickle.load(f)

# Load updated predefined topics
topics_path = '${path.join(this.modelPath, 'predefined_topics.json')}'
if not os.path.exists(topics_path):
    print("Predefined topics not found")
    exit(1)
    
with open(topics_path, 'r') as f:
    predefined_topics = json.load(f)

# Convert to format expected by BERTopic
seed_topic_list = []
for topic_name, keywords in predefined_topics.items():
    seed_topic_list.append((topic_name, keywords))

# Update model's seed topics
model.seed_topic_list = seed_topic_list

# Save updated model
with open(model_path, 'wb') as f:
    pickle.dump(model, f)

print("Updated guided BERTopic model with new predefined topics")
      `);

            elizaLogger.log("[GuidedTopicManager] Updated guided model with new predefined topics");
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error updating guided model: ${error}`);
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

        // Save and update model
        await this.savePredefinedTopics();

        // Update the model asynchronously
        this.updateGuidedModel().catch(error => {
            elizaLogger.error(`[GuidedTopicManager] Error updating model after adding topic: ${error}`);
        });
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

        // Save and update model
        await this.savePredefinedTopics();

        // Update the model asynchronously
        this.updateGuidedModel().catch(error => {
            elizaLogger.error(`[GuidedTopicManager] Error updating model after adding keywords: ${error}`);
        });
    }

    /**
     * Get all predefined topics with their keywords
     */
    getPredefinedTopics(): Map<string, string[]> {
        return new Map(this.predefinedTopics);
    }

    /**
     * Enhance a topic name to be more human-readable
     */
    private async enhanceTopicName(topic: string, context: string = ""): Promise<string> {
        try {
            // If the topic is already good, just capitalize it
            if (this.isGoodTopicName(topic)) {
                return this.capitalizeFirstLetter(topic);
            }

            // Otherwise, use LLM to generate a better name
            const prompt = `
      Create a concise, human-readable topic name (2-5 words) based on this topic and context.
      
      Topic: ${topic}
      Context: "${context.substring(0, 200)}${context.length > 200 ? '...' : ''}"
      
      The topic name should:
      - Be clear and specific
      - Use natural language (not just keywords)
      - Capture the essence of the topic
      - Be suitable for use in conversation
      
      Return only the topic name, with no additional explanation.
      `;

            const response = await generateText({
                runtime: this.runtime,
                context: prompt,
                modelClass: ModelClass.SMALL
            });

            // Clean up the response
            let enhancedTopic = response.trim();

            // Remove quotes if present
            enhancedTopic = enhancedTopic.replace(/^["'](.*)["']$/, '$1');

            return enhancedTopic;
        } catch (error) {
            elizaLogger.error(`[GuidedTopicManager] Error enhancing topic name: ${error}`);
            return this.capitalizeFirstLetter(topic);
        }
    }

    /**
     * Check if a topic name is already good
     */
    private isGoodTopicName(topic: string): boolean {
        // Good topic characteristics

        // 1. Properly formatted named entities are good
        const namedEntityPattern = /^[A-Z][a-z]+(?: [A-Z][a-z]+)*$/;
        if (namedEntityPattern.test(topic)) {
            return true;
        }

        // 2. Common concept patterns (Artificial Intelligence, Climate Change)
        const conceptPattern = /^[A-Za-z]+ [A-Za-z]+$/;
        if (conceptPattern.test(topic) && topic.length > 8) {
            return true;
        }

        // 3. Well-known domain terms
        const commonDomains = [
            "artificial intelligence", "machine learning", "data science",
            "climate change", "renewable energy", "social media",
            "public health", "cloud computing", "quantum computing",
            "virtual reality", "augmented reality", "remote work",
            "cryptocurrency", "blockchain", "neural networks"
        ];

        if (commonDomains.includes(topic.toLowerCase())) {
            return true;
        }

        return false;
    }

    /**
     * Capitalize the first letter of a string
     */
    private capitalizeFirstLetter(text: string): string {
        if (!text) return text;
        return text.charAt(0).toUpperCase() + text.slice(1);
    }
}