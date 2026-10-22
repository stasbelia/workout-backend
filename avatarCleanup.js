async function cleanAvatarJobs({ pool, storage }) {
  const jobs = await pool.query('SELECT object_key FROM avatar_cleanup_jobs WHERE available_at <= now() ORDER BY created_at LIMIT 20');
  for (const { object_key: key } of jobs.rows) {
    if (!/^avatars\/(pending|verified)\/\d+\/[0-9a-f-]+\.(jpg|png)$/.test(key)) continue;
    const active = await pool.query('SELECT id FROM users WHERE avatar_key = $1', [key]);
    if (active.rows.length) continue;
    await storage.remove(key);
    await pool.query('DELETE FROM avatar_cleanup_jobs WHERE object_key = $1', [key]);
  }
}

function startAvatarCleanup(dependencies) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await cleanAvatarJobs(dependencies); }
    catch { console.error('[АВАТАР] Прибирання відкладене; повторимо пізніше.'); }
    finally { running = false; }
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
module.exports = startAvatarCleanup;
module.exports.cleanAvatarJobs = cleanAvatarJobs;
