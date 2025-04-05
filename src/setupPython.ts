// src/setupPython.ts
import { PythonShell } from 'python-shell';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

async function setupPython() {
    console.log('Setting up Python environment for BERTopic...');

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

    // Create virtual environment if it doesn't exist
    const venvPath = path.join(pythonDir, 'venv');
    if (!fs.existsSync(venvPath)) {
        console.log('Creating Python virtual environment...');
        try {
            // Use --with-pip to ensure pip is installed
            execSync('python3 -m venv --with-pip ' + venvPath);

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

    // Run Python setup script
    try {
        const result = await PythonShell.run(
            path.join(pythonDir, 'setup_bertopic.py'),
            {
                mode: 'text',
                pythonPath: pythonExecutable,
            }
        );

        console.log('Python setup completed:');
        result.forEach(line => console.log(line));
    } catch (error) {
        console.error('Error setting up Python environment:', error);
        process.exit(1);
    }
}

setupPython();