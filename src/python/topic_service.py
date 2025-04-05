# src/python/topic_service.py
import json
import os
import pickle
import sys
import traceback
import zmq
from typing import Dict, List, Any, Optional
import time

import numpy as np
try:
    from bertopic import BERTopic
    from sentence_transformers import SentenceTransformer
    import spacy
except ImportError:
    print("Required libraries not found. Installing...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", 
                          "bertopic", "sentence-transformers", "spacy", "pyzmq"])
    from bertopic import BERTopic
    from sentence_transformers import SentenceTransformer
    import spacy

class TopicModelingService:
    """Persistent service for BERTopic-based topic modeling"""
    
    def __init__(self, model_dir: str):
        self.model_dir = model_dir
        self.model_path = os.path.join(model_dir, 'model.pkl')
        self.predefined_topics_path = os.path.join(model_dir, 'predefined_topics.json')
        
        # Ensure directories exist
        os.makedirs(model_dir, exist_ok=True)
        
        # Initialize components
        self.nlp = None
        self.model = None
        self.embedding_model = None
        self.initialize_components()
        
        # Set up ZeroMQ socket for communication
        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.REP)
        self.running = True
    
    def initialize_components(self):
        """Initialize spaCy and BERTopic components"""
        print("Initializing NLP components...")
        
        # Initialize spaCy
        try:
            self.nlp = spacy.load("en_core_web_sm")
            print("Loaded spaCy model")
        except:
            print("Downloading spaCy model...")
            import subprocess
            subprocess.check_call([sys.executable, "-m", "spacy", "download", "en_core_web_sm"])
            self.nlp = spacy.load("en_core_web_sm")
        
        # Initialize embedding model
        self.embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
        print("Loaded sentence transformer model")
        
        # Load predefined topics
        predefined_topics = {}
        if os.path.exists(self.predefined_topics_path):
            try:
                with open(self.predefined_topics_path, 'r') as f:
                    predefined_topics = json.load(f)
                print(f"Loaded {len(predefined_topics)} predefined topics from {self.predefined_topics_path}")
            except Exception as e:
                print(f"Error loading predefined topics: {e}")
                
        # Convert to seed topic list format
        seed_topic_list = []
        for topic_name, keywords in predefined_topics.items():
            seed_topic_list.append((topic_name, keywords))
        
        # Load or initialize BERTopic model
        if os.path.exists(self.model_path):
            print(f"Loading existing BERTopic model from {self.model_path}")
            try:
                with open(self.model_path, 'rb') as f:
                    self.model = pickle.load(f)
                
                # Update seed topics in the loaded model
                if seed_topic_list:
                    print(f"Updating model with {len(seed_topic_list)} seed topics")
                    self.model.seed_topic_list = seed_topic_list
            except Exception as e:
                print(f"Error loading model: {e}")
                traceback.print_exc()
                print("Creating a new model instead")
                self.model = None
        
        # If model loading failed or no model exists, create a new one
        if self.model is None:
            print("Initializing new BERTopic model")
            
            # Create model with predefined topics
            self.model = BERTopic(
                embedding_model=self.embedding_model,
                min_topic_size=2,
                seed_topic_list=seed_topic_list,
                calculate_probabilities=True
            )
            
            # Initialize with a placeholder document
            print("Initializing model with placeholder document")
            docs = ["This is a placeholder document to initialize the model structure."]
            topics, probs = self.model.fit_transform(docs)
            
            # Save the model
            with open(self.model_path, 'wb') as f:
                pickle.dump(self.model, f)
        
        print("NLP components initialized successfully")
    
    def extract_entities(self, text: str) -> List[str]:
        """Extract named entities from text"""
        entities = []
        try:
            # Limit length for performance
            doc = self.nlp(text[:1000])
            for ent in doc.ents:
                if ent.label_ in ["ORG", "PERSON", "GPE", "PRODUCT", "WORK_OF_ART", "EVENT"]:
                    entities.append(ent.text)
        except Exception as e:
            print(f"Error extracting entities: {e}")
            traceback.print_exc()
        
        return entities
    
    def discover_topics(self, texts: List[str]) -> List[List[Dict[str, Any]]]:
        """Discover topics in a list of texts using BERTopic"""
        try:
            if not texts:
                return []
            
            # Get topics and probabilities
            topics, probs = self.model.transform(texts)
            
            # Process each document's topics
            all_topics = []
            
            for i, doc_topic in enumerate(topics):
                doc_text = texts[i]
                
                # Extract entities
                entities = self.extract_entities(doc_text)
                
                # Process based on assigned topic
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
                            if probs[i][idx] > 0.65:  # Topic threshold
                                topic_keywords = self.model.get_topic(idx)
                                if topic_keywords:  # Ensure we have keywords
                                    keywords = [word for word, _ in topic_keywords[:5]]
                                    topic_info.append({
                                        "topic": " ".join(keywords[:2]),
                                        "keywords": keywords,
                                        "is_predefined": self._is_predefined_topic(idx),
                                        "probability": float(probs[i][idx]),
                                        "representative_text": doc_text
                                    })
                        all_topics.append(topic_info)
                    else:
                        all_topics.append([])
                else:
                    # Get topic keywords
                    topic_keywords = self.model.get_topic(doc_topic)
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
                        "is_predefined": self._is_predefined_topic(doc_topic),
                        "probability": float(probs[i][doc_topic] if probs[i] is not None else 1.0),
                        "representative_text": doc_text
                    }])
            
            return all_topics
        except Exception as e:
            print(f"Error discovering topics: {e}")
            traceback.print_exc()
            return []
    
    def _is_predefined_topic(self, topic_idx):
        """Check if a topic index corresponds to a predefined topic"""
        try:
            if hasattr(self.model, 'topic_labels_'):
                return topic_idx < len(self.model.topic_labels_)
            
            # Alternative check for newer BERTopic versions
            if hasattr(self.model, '_guided_topic_mapping'):
                return topic_idx in self.model._guided_topic_mapping
                
            # Alternative check based on seed topics
            if hasattr(self.model, 'seed_topic_list') and self.model.seed_topic_list:
                # Heuristic: predefined topics usually have lower indices
                return topic_idx < len(self.model.seed_topic_list)
        except:
            pass
        return False
    
    def update_predefined_topics(self, predefined_topics: Dict[str, List[str]]) -> bool:
        """Update the model with new predefined topics"""
        try:
            print(f"Updating model with {len(predefined_topics)} predefined topics")
            
            # Save predefined topics to file
            with open(self.predefined_topics_path, 'w') as f:
                json.dump(predefined_topics, f)
            
            # Convert to format expected by BERTopic
            seed_topic_list = []
            for topic_name, keywords in predefined_topics.items():
                seed_topic_list.append((topic_name, keywords))
            
            # Update model's seed topics
            print("Setting seed topic list in model")
            self.model.seed_topic_list = seed_topic_list
            
            # For newer BERTopic versions, we may need to update guided topics differently
            if hasattr(self.model, 'update_guided_topics'):
                print("Using update_guided_topics method")
                self.model.update_guided_topics(seed_topic_list)
            
            # Save updated model
            print(f"Saving updated model to {self.model_path}")
            with open(self.model_path, 'wb') as f:
                pickle.dump(self.model, f)
            
            print(f"Successfully updated model with {len(predefined_topics)} predefined topics")
            return True
        except Exception as e:
            print(f"Error updating predefined topics: {e}")
            traceback.print_exc()
            return False
    
    def process_request(self, request: Dict) -> Dict:
        """Process a client request"""
        try:
            command = request.get("command")
            
            if command == "discover_topics":
                texts = request.get("texts", [])
                result = self.discover_topics(texts)
                return {
                    "status": "success",
                    "result": result
                }
            elif command == "update_topics":
                predefined_topics = request.get("predefined_topics", {})
                success = self.update_predefined_topics(predefined_topics)
                return {
                    "status": "success" if success else "error",
                    "result": success
                }
            elif command == "extract_entities":
                text = request.get("text", "")
                entities = self.extract_entities(text)
                return {
                    "status": "success",
                    "result": entities
                }
            elif command == "health_check":
                return {
                    "status": "success",
                    "result": {
                        "model_loaded": self.model is not None,
                        "embedding_model_loaded": self.embedding_model is not None,
                        "spacy_loaded": self.nlp is not None,
                        "seed_topics_count": len(self.model.seed_topic_list) if hasattr(self.model, 'seed_topic_list') and self.model.seed_topic_list else 0
                    }
                }
            else:
                return {
                    "status": "error",
                    "error": f"Unknown command: {command}"
                }
        except Exception as e:
            print(f"Error processing request: {e}")
            traceback.print_exc()
            return {
                "status": "error",
                "error": str(e)
            }
    
    def start(self, port=5555):
        """Start the service on the specified port"""
        try:
            self.socket.bind(f"tcp://127.0.0.1:{port}")
            print(f"Topic modeling service is running on port {port}. Press Ctrl+C to exit.")
            
            while self.running:
                try:
                    # Wait for request
                    message = self.socket.recv_string()
                    print(f"Received request: {message[:100]}...")
                    
                    # Parse request
                    request = json.loads(message)
                    
                    # Process request
                    start_time = time.time()
                    response = self.process_request(request)
                    processing_time = time.time() - start_time
                    
                    # Send response
                    self.socket.send_string(json.dumps(response))
                    print(f"Response sent (processing took {processing_time:.2f}s)")
                except zmq.ZMQError as e:
                    print(f"ZMQ error: {e}")
                    # Brief pause to prevent CPU spinning on errors
                    time.sleep(0.1)
                except Exception as e:
                    print(f"Error processing request: {e}")
                    traceback.print_exc()
                    # Send error response
                    try:
                        self.socket.send_string(json.dumps({
                            "status": "error",
                            "error": str(e)
                        }))
                    except:
                        pass
        except KeyboardInterrupt:
            print("Shutting down service...")
        except Exception as e:
            print(f"Error starting service: {e}")
            traceback.print_exc()
        finally:
            self.socket.close()
            self.context.term()

if __name__ == "__main__":
    # Parse arguments
    model_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.getcwd(), 'models', 'bertopic_model')
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 5555
    
    print(f"Starting Topic Modeling Service with model directory: {model_dir}")
    service = TopicModelingService(model_dir)
    service.start(port)