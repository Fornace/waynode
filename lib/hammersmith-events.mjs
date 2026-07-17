const subscribers = new Map();

export function hammersmithJobEvent(job, publicJob) {
  return {
    type: "hammersmith_run",
    submission: {
      id: job.submission_id,
      prompt: job.job_description,
      mode: "hammersmith",
      isGoal: false,
      status: "completed",
      createdAt: job.created_at,
      job: publicJob,
    },
  };
}

export function publishHammersmithJob(job, publicJob) {
  if (!job?.session_id || !job?.submission_id || !publicJob) return;
  for (const subscriber of subscribers.get(job.session_id) || []) {
    try { subscriber(hammersmithJobEvent(job, publicJob)); } catch {}
  }
}

export function subscribeHammersmithJobs(sessionId, subscriber) {
  let sessionSubscribers = subscribers.get(sessionId);
  if (!sessionSubscribers) {
    sessionSubscribers = new Set();
    subscribers.set(sessionId, sessionSubscribers);
  }
  sessionSubscribers.add(subscriber);
  return () => {
    sessionSubscribers.delete(subscriber);
    if (!sessionSubscribers.size) subscribers.delete(sessionId);
  };
}
