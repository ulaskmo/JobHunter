const TelegramBot = require("node-telegram-bot-api");
const { getStats, getJobs, db } = require("./database");
require("dotenv").config();

let bot = null;

function initTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("[Telegram] Not configured, skipping.");
    return;
  }

  bot = new TelegramBot(token, { polling: true });
  console.log("[Telegram] Job bot initialized.");

  bot.on("polling_error", (err) => {
    console.error(`[Telegram] Polling error: ${err.code || ""} ${err.message}`);
  });
  bot.on("error", (err) => {
    console.error(`[Telegram] Bot error: ${err.message}`);
  });

  bot.on("message", async (msg) => {
    if (String(msg.chat.id) !== String(chatId)) return;
    const text = (msg.text || "").trim().toLowerCase();

    if (text === "/status") {
      const stats = getStats.get();
      await bot.sendMessage(msg.chat.id,
        `<b>Job Hunter Status</b>\n\n` +
        `Total jobs found: ${stats.total}\n` +
        `New: ${stats.new_count}\n` +
        `Applied: ${stats.applied_count}\n` +
        `Interviews: ${stats.interview_count}\n` +
        `S tier (8.0+): ${stats.priority_count}\n` +
        `Saved: ${stats.saved_count}`,
        { parse_mode: "HTML" }
      );

    } else if (text === "/priority") {
      const jobs = db.prepare(
        "SELECT * FROM jobs WHERE score >= 80 AND status = 'new' AND filter_reason IS NULL AND is_expired = 0 ORDER BY score DESC LIMIT 10"
      ).all();
      if (jobs.length === 0) {
        await bot.sendMessage(msg.chat.id, "No new priority jobs right now.");
        return;
      }
      let msg_text = "<b>Top Priority Jobs</b>\n\n";
      for (const job of jobs) {
        msg_text += `<b>${job.title}</b>\n`;
        msg_text += `${job.company} - ${job.location}\n`;
        msg_text += `Score: ${(job.score / 10).toFixed(1)} · ${job.rating} | ${job.source}\n`;
        msg_text += `${job.url}\n\n`;
      }
      await bot.sendMessage(msg.chat.id, msg_text, { parse_mode: "HTML", disable_web_page_preview: true });

    } else if (text === "/recent") {
      const jobs = db.prepare(
        "SELECT * FROM jobs ORDER BY scraped_at DESC LIMIT 10"
      ).all();
      if (jobs.length === 0) {
        await bot.sendMessage(msg.chat.id, "No jobs found yet.");
        return;
      }
      let msg_text = "<b>10 Most Recent Jobs</b>\n\n";
      for (const job of jobs) {
        msg_text += `<b>${job.title}</b>\n`;
        msg_text += `${job.company} - ${job.location}\n`;
        msg_text += `Score: ${(job.score / 10).toFixed(1)} · ${job.rating} | ${job.source}\n\n`;
      }
      await bot.sendMessage(msg.chat.id, msg_text, { parse_mode: "HTML" });

    } else if (text === "/help") {
      await bot.sendMessage(msg.chat.id,
        `<b>Job Hunter Commands</b>\n\n` +
        `/status - Stats overview\n` +
        `/priority - Top priority jobs\n` +
        `/recent - 10 most recent jobs\n` +
        `/help - This message`,
        { parse_mode: "HTML" }
      );
    }
  });
}

async function sendAlert(message) {
  if (!bot) return;
  try {
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error(`[Telegram] Send failed: ${err.message}`);
  }
}

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Telegram caps messages at 4096 chars, so send in chunks of 10 jobs.
const MAX_ALERT_JOBS = 50;
async function notifyPriorityJobs(jobs) {
  if (!bot || jobs.length === 0) return;
  const shown = jobs.slice(0, MAX_ALERT_JOBS);
  for (let i = 0; i < shown.length; i += 10) {
    let msg = i === 0 ? `<b>🔔 ${jobs.length} new job${jobs.length > 1 ? "s" : ""}</b>\n\n` : "";
    for (const job of shown.slice(i, i + 10)) {
      msg += `<b>${esc(job.title)}</b>\n`;
      msg += `${esc(job.company)} - ${esc(job.location)}\n`;
      msg += `Score: ${(job.score / 10).toFixed(1)} · ${job.rating} | ${job.source}\n`;
      msg += `${esc(job.url)}\n\n`;
    }
    await sendAlert(msg);
  }
  if (jobs.length > MAX_ALERT_JOBS) {
    await sendAlert(`...and ${jobs.length - MAX_ALERT_JOBS} more. Check the dashboard.`);
  }
}

async function stopTelegram() {
  if (!bot) return;
  try {
    await bot.stopPolling({ cancel: true });
  } catch (err) {
    console.error(`[Telegram] stopPolling failed: ${err.message}`);
  }
}

module.exports = { initTelegram, sendAlert, notifyPriorityJobs, stopTelegram };
