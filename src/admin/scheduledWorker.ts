import { timingSafeEqual } from "node:crypto";
import { Request, Response } from "express";
import { runScheduledWorker } from "../worker";

export async function handleScheduledWorker(req: Request, res: Response) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    res.json(await runScheduledWorker());
  } catch {
    res.status(500).json({ error: "Worker batch failed" });
  }
}
