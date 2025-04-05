import sys
import subprocess
import os

def setup_bertopic():
    """Set up BERTopic and its dependencies."""
    # Create requirements.txt if it doesn't exist
    requirements_path = os.path.join(os.path.dirname(__file__), "requirements.txt")
    if not os.path.exists(requirements_path):
        print("Creating requirements.txt...")
        with open(requirements_path, "w") as f:
            f.write("bertopic\nsentence-transformers\nspacy\n")
            
    # Install packages
    print("Installing BERTopic and dependencies...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", requirements_path])

    # Download spaCy model
    print("Downloading spaCy model...")
    subprocess.check_call([sys.executable, "-m", "spacy", "download", "en_core_web_sm"])

    # Create model directory
    model_dir = os.path.join(os.path.dirname(__file__), "models", "bertopic_model")
    os.makedirs(model_dir, exist_ok=True)

    print("Setup complete!")

if __name__ == "__main__":
    setup_bertopic()