import { hasRunningHammersmithJob } from "./hammersmith-store.mjs";

export function hammersmithLeaseError(spaceId) {
  if (!spaceId || !hasRunningHammersmithJob(spaceId)) return null;
  const error = new Error("A Hammersmith job is modifying this Space");
  error.status = 409;
  error.hammersmithBusy = true;
  return error;
}

export function requireHammersmithLeaseAvailable(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const error = hammersmithLeaseError(req.params.spaceId);
  if (error) return res.status(error.status).json({ error: error.message, hammersmithBusy: true });
  next();
}

export function assertHammersmithLeaseAvailable(spaceId) {
  const error = hammersmithLeaseError(spaceId);
  if (error) throw error;
}
