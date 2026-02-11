import express from "express";
import cors from "cors";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
// ================================
// Supabase Setup
// ================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = process.env.SUPABASE_BUCKET || "clips";

// ================================
// Local folders
// ================================
const TEMP_DIR = "./temp";
const OUTPUT_DIR = "./clips";

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// ================================
// Upload Trimmed Clip to Supabase
// ================================
async function uploadClipToSupabase(filePath) {
  const fileBuffer = fs.readFileSync(filePath);

  const fileName = `final/${path.basename(filePath)}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(fileName, fileBuffer, {
      contentType: "video/mp4",
      upsert: true,
    });

  if (error) throw error;

  // Get public URL
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);

  return data.publicUrl;
}

// ================================
// POST /api/clip
// ================================
app.post("/api/clip", async (req, res) => {
  try {
    const { videoUrl, startTime, endTime, format, resolution } = req.body;

    if (!videoUrl || startTime == null || endTime == null) {
      return res.status(400).json({
        error: "Missing required fields: videoUrl, startTime, endTime",
      });
    }

    console.log("🎬 Clip Request Received:", req.body);

    const id = uuidv4();

    // Local paths
    const inputPath = path.join(TEMP_DIR, `${id}.mp4`);
    const outputPath = path.join(
      OUTPUT_DIR,
      `${id}.${format || "mp4"}`
    );

    // ================================
    // Step 1: Download Video (Temporary Local Only)
    // ================================
    console.log("⬇️ Downloading video temporarily...");

    const response = await axios({
      url: videoUrl,
      method: "GET",
      responseType: "stream",
    });

    const writer = fs.createWriteStream(inputPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    console.log("✅ Video downloaded locally");

    // ================================
    // Step 2: Trim Clip with FFmpeg
    // ================================
    console.log("✂️ Trimming clip...");

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(endTime - startTime)
        .size(resolution || "1080x1920")
        .outputOptions([
          "-preset fast",
          "-movflags +faststart",
          "-c:v libx264",
          "-c:a aac",
        ])
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);
    });

    console.log("✅ Clip created:", outputPath);

    // ================================
    // Step 3: Upload ONLY Trimmed Clip to Supabase
    // ================================
    console.log("☁ Uploading trimmed clip to Supabase...");

    const clipUrl = await uploadClipToSupabase(outputPath);

    console.log("✅ Clip uploaded:", clipUrl);

    // ================================
    // Step 4: Cleanup Local Files
    // ================================
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    console.log("🧹 Local temp files deleted");

    // ================================
    // Step 5: Return Supabase URL
    // ================================
    return res.json({
      success: true,
      clipUrl,
    });
  } catch (error) {
    console.error("❌ Server Error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ================================
// Start Server
// ================================
const PORT = process.env.PORT || 5000; // fallback for local dev

app.listen(PORT, () => {
  console.log(`🚀 FFmpeg Clip Server Running on Port ${PORT}`);
});
