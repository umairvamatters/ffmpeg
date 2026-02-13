import express from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
const ffmpegPath = (() => {
  try {
    return execSync("which ffmpeg").toString().trim(); // Mac/Linux
  } catch {
    return "C:\\ffmpeg\\bin\\ffmpeg.exe"; // Windows fallback (adjust your path)
  }
})();

ffmpeg.setFfmpegPath(ffmpegPath);
// ================================
// Supabase Setup
// ================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const BUCKET = process.env.SUPABASE_BUCKET || "clips";

// ================================
// POST /api/clip
// ================================
app.post("/api/clip", async (req, res) => {
  const startTotalTime = Date.now();
  
  try {
    const { videoUrl, startTime, endTime, format, resolution } = req.body;

    if (!videoUrl || startTime == null || endTime == null) {
      return res.status(400).json({
        error: "Missing required fields: videoUrl, startTime, endTime",
      });
    }

    console.log("🎬 Clip Request Received:", req.body);

    const id = uuidv4();
    const fileName = `final/${id}.${format || "mp4"}`;

    // ================================
    // Create PassThrough Stream for FFmpeg Output
    // ================================
    const outputStream = new PassThrough();
    const chunks = [];

    // Collect stream data
    outputStream.on("data", (chunk) => {
      chunks.push(chunk);
    });

    console.log("✂️ Trimming clip from URL (no local storage)...");
    const ffmpegStartTime = Date.now();

    // ================================
    // FFmpeg: Direct URL Input → Stream Output
    // ================================
    await new Promise((resolve, reject) => {
      let ffmpegFinished = false;
      let streamFinished = false;
      
      const checkBothFinished = () => {
        if (ffmpegFinished && streamFinished) {
          const ffmpegDuration = ((Date.now() - ffmpegStartTime) / 1000).toFixed(2);
          console.log(`✅ Both FFmpeg and Stream completed (took ${ffmpegDuration}s)`);
          resolve();
        }
      };
      
      const command = ffmpeg(videoUrl)
        .setStartTime(startTime)
        .setDuration(endTime - startTime)
        .size(resolution || "1080x1920")
        .outputOptions([
          "-preset ultrafast",
          "-movflags frag_keyframe+empty_moov",
          "-c:v libx264",
          "-c:a aac",
          "-f mp4",
        ])
        .on("start", (cmd) => {
          console.log("🎥 FFmpeg started");
        })
        .on("progress", (progress) => {
          if (progress.percent) {
            console.log(`⏳ Processing: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on("end", () => {
          console.log("✅ FFmpeg completed");
          ffmpegFinished = true;
          checkBothFinished();
        })
        .on("error", (err) => {
          console.error("❌ FFmpeg Error:", err.message);
          reject(err);
        });

      // Wait for stream to finish collecting all data
      outputStream.on("finish", () => {
        console.log(`✅ Stream finished collecting data`);
        streamFinished = true;
        checkBothFinished();
      });

      outputStream.on("error", reject);

      // Pipe to stream
      command.pipe(outputStream, { end: true });
    });

    // ================================
    // Prepare Buffer
    // ================================
    console.log("📦 Preparing buffer...");
    const bufferStartTime = Date.now();
    
    const fileBuffer = Buffer.concat(chunks);
    const bufferSize = (fileBuffer.length / 1024 / 1024).toFixed(2);
    const bufferDuration = ((Date.now() - bufferStartTime) / 1000).toFixed(2);
    
    console.log(`📦 Buffer ready: ${bufferSize} MB (took ${bufferDuration}s)`);

    if (fileBuffer.length === 0) {
      throw new Error("FFmpeg produced empty buffer");
    }

    // ================================
    // Upload to Supabase
    // ================================
    console.log("☁️ Starting upload to Supabase...");
    const uploadStartTime = Date.now();

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, fileBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

    const uploadDuration = ((Date.now() - uploadStartTime) / 1000).toFixed(2);
    console.log(`⏱️ Upload took ${uploadDuration}s`);

    if (uploadError) {
      console.error("❌ Supabase Upload Error:", uploadError);
      throw new Error(`Supabase upload failed: ${uploadError.message}`);
    }

    console.log("✅ Upload successful");

    // Get public URL
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
    const clipUrl = data.publicUrl;

    const totalDuration = ((Date.now() - startTotalTime) / 1000).toFixed(2);
    console.log(`✅ Clip uploaded: ${clipUrl}`);
    console.log(`⏱️ Total processing time: ${totalDuration}s`);


    const callbackPayload = {
      user_id: req.body.user_id,
      video_id: req.body.video_id,
      clipUrl,
      privacyStatus: "public",
    };

    const callbackResponse = await fetch(
  `${process.env.SUPABASE_URL}/functions/v1/worker-upload-callback`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(callbackPayload),
  }
);

const callbackResult = await callbackResponse.json();

console.log("✅ Callback Response:", callbackResult);

    // ================================
    // Return Supabase URL
    // ================================
    return res.json({
      success: true,
      clipUrl,
      processingTime: totalDuration
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
// Health Check
// ================================
app.get("/", (req, res) => {
  res.json({ status: "FFmpeg Clip Server is running" });
});

// ================================
// Start Server
// ================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 FFmpeg Clip Server Running on Port ${PORT}`);
});