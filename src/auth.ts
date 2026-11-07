import { Request, Response, NextFunction } from "express";
import { config } from "./config";

// Verify the Google id_token the frontend sends as a Bearer token.
// We check it against Google's tokeninfo endpoint and make sure it was
// issued for our client. The verified email is attached to the request.
export interface AuthedRequest extends Request {
  userEmail?: string;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "missing token" });

  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    const data: any = await r.json();

    if (!r.ok || !data.email) {
      return res.status(401).json({ error: "invalid token" });
    }
    // make sure the token was minted for our app
    if (config.googleClientId && data.aud !== config.googleClientId) {
      return res.status(401).json({ error: "wrong audience" });
    }

    req.userEmail = data.email;
    next();
  } catch {
    res.status(401).json({ error: "auth failed" });
  }
}
