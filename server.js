import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'reports.json');
const PORT = process.env.PORT || 5000;

// --- Helper Functions for Database ---
const readReports = () => {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      writeReports([]);
      return [];
    }
    console.error("Error reading from database:", err);
    return [];
  }
};

const writeReports = (data) => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error("Error writing to database:", err);
  }
};

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use(express.static(__dirname));

let reports = readReports();

// --- Main Report APIs ---

app.get("/api/reports", (req, res) => {
  res.json(reports);
});

app.post("/api/reports", (req, res) => {
  const { title, description, location, image, category } = req.body;
  const newReport = {
    id: uuidv4(),
    title, description, location, image, category,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  reports.push(newReport);
  writeReports(reports);
  console.log(`New report submitted with category: ${category}`);
  res.status(201).json(newReport);
});

app.put("/api/reports/:id", (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const reportIndex = reports.findIndex((r) => r.id === id);
  if (reportIndex === -1) return res.status(404).json({ message: "Report not found" });
  
  reports[reportIndex].status = status;
  if (status === 'verified') {
    reports[reportIndex].verifiedAt = new Date().toISOString();
  }
  writeReports(reports);
  console.log(`Report ${id} updated to ${status}`);
  res.json(reports[reportIndex]);
});

app.put("/api/reports/:id/fine", (req, res) => {
    const { id } = req.params;
    const reportIndex = reports.findIndex((r) => r.id === id);
    if (reportIndex === -1) return res.status(404).json({ message: "Report not found" });

    reports[reportIndex].fineCollected = 600;
    reports[reportIndex].rewardDisbursed = 500;
    reports[reportIndex].status = 'resolved';
    reports[reportIndex].resolvedAt = new Date().toISOString();
    writeReports(reports);
    console.log(`Fine issued for report ${id}`);
    res.json(reports[reportIndex]);
});

app.put("/api/reports/:id/resolve", (req, res) => {
    const { id } = req.params;
    const reportIndex = reports.findIndex((r) => r.id === id);
    if (reportIndex === -1) return res.status(404).json({ message: "Report not found" });

    reports[reportIndex].status = 'resolved';
    reports[reportIndex].resolvedAt = new Date().toISOString();
    writeReports(reports);
    console.log(`Report ${id} marked as resolved (no fine)`);
    res.json(reports[reportIndex]);
});


// --- Secure AI Proxy APIs ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY not found in .env file. AI features will not work.");
}
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent";

const callGeminiApi = async (payload, res, errorMsg) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ message: "Server is not configured with an API key." });
    }
    try {
        const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorBody = await response.json();
            console.error("Gemini API Error:", errorBody);
            throw new Error(errorBody.error.message || "Failed to call Gemini API");
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error(`${errorMsg} failed:`, error);
        res.status(500).json({ message: errorMsg });
    }
};

app.post("/api/ai/generate-suggestions", async (req, res) => {
  const { location } = req.body;
  const systemPrompt = "You are an assistant for a civic reporting app. Based on the user's input about a location and implied issue, generate a concise, formal title and a descriptive paragraph for the report. The location is Agra, India. Output a valid JSON object with 'title' and 'description' keys, and nothing else.";
  const payload = {
    contents: [{ parts: [{ text: location }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { responseMimeType: "application/json" }
  };

  const data = await callGeminiApi(payload, res, "Failed to generate AI suggestions.");
  
  // Safety Check Added Here
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (text) {
     res.json(JSON.parse(text));
  } else {
     console.error("Unexpected API response structure:", JSON.stringify(data, null, 2));
     res.status(500).json({ message: "Failed to parse AI response for suggestions." });
  }
});

app.post("/api/ai/analyze-image", async (req, res) => {
  const { image } = req.body;
  const payload = {
    contents: [{
      role: "user",
      parts: [
        { text: "Analyze this image of a civic issue in Agra, India. Describe the problem in a concise, formal paragraph for a report. Do not mention that you are looking at an image." },
        { inlineData: { mimeType: "image/jpeg", data: image } }
      ]
    }],
  };
  
  const data = await callGeminiApi(payload, res, "Failed to analyze image.");

  // Safety Check Added Here
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (text) {
    res.json({ description: text });
  } else {
     console.error("Unexpected API response structure:", JSON.stringify(data, null, 2));
     res.status(500).json({ message: "Failed to parse AI response for image analysis." });
  }
});

app.post("/api/ai/categorize-report", async (req, res) => {
    const { title, description } = req.body;
    const systemPrompt = `You are an AI classifier for a civic reporting app. Based on the report's title and description, categorize it into one of the following options: "Waste Management", "Infrastructure", "Illegal Construction", "Traffic Violation", "Women's Safety", "Public Nuisance", or "General". Output a valid JSON object with only a "category" key. For example: {"category": "Waste Management"}`;
    const payload = {
        contents: [{ parts: [{ text: `Title: ${title}\nDescription: ${description}` }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" }
    };

    const data = await callGeminiApi(payload, res, "Failed to categorize report.");

    // Safety Check Added Here
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
        try {
            const parsed = JSON.parse(text);
            res.json({ category: parsed.category || "General" });
        } catch (e) {
            res.json({ category: "General" });
        }
    } else {
        console.error("Unexpected API response structure:", JSON.stringify(data, null, 2));
        res.status(500).json({ message: "Failed to parse AI response for categorization." });
    }
});

app.post("/api/ai/generate-dashboard-summary", async (req, res) => {
    const { reports } = req.body;
    const systemPrompt = `You are an expert civic data analyst for the city of Agra, India. Analyze the provided JSON of civic reports. Identify the top 2-3 common issues, pinpoint the busiest locations, and suggest one concrete, actionable step for the municipal authorities. Provide a concise, professional summary as a single block of text. Do not use markdown formatting.`;
    const payload = {
        contents: [{ parts: [{ text: `Here are the recent reports: ${JSON.stringify(reports)}` }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
    };

    const data = await callGeminiApi(payload, res, "Failed to generate dashboard summary.");
    
    // Safety Check Added Here
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
        res.json({ summary: text });
    } else {
        console.error("Unexpected API response structure:", JSON.stringify(data, null, 2));
        res.status(500).json({ message: "Failed to parse AI response for summary." });
    }
});




// Serve static files from current directory
app.use(express.static(__dirname));

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
