const { randomUUID } = require('node:crypto');
const AvatarError = require('./avatarErrors');
const normalizeAvatar = require('./avatarImage');

function createAvatarService({ pool, storage }) {
  async function findUser(userId) {
    const result = await pool.query('SELECT id, avatar_key, avatar_upload_key FROM users WHERE id = $1', [userId]);
    if (!result.rows[0]) throw new AvatarError(401, 'Користувача не знайдено. Увійдіть повторно.');
    return result.rows[0];
  }

  return {
    async get(userId) {
      const user = await findUser(userId);
      return user.avatar_key ? storage.readUrl(user.avatar_key) : null;
    },

    async complete(userId, pendingKey) {
      // Клієнт може підтвердити лише файл у власній pending-області.
      const prefix = `avatars/pending/${userId}/`;
      if (typeof pendingKey !== 'string' || !pendingKey.startsWith(prefix) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png)$/.test(pendingKey.slice(prefix.length))) {
        throw new AvatarError(400, 'Некоректний ключ завантаженого фото.');
      }
      const user = await findUser(userId);
      // Повтор після втрати HTTP-відповіді не потребує вже видаленого pending-файла.
      if (user.avatar_upload_key === pendingKey && user.avatar_key) return storage.readUrl(user.avatar_key);

      const bytes = await storage.readPending(pendingKey);
      const jpeg = await normalizeAvatar(bytes);
      const key = `avatars/verified/${userId}/${randomUUID()}.jpg`;
      // Спочатку надійно реєструємо майбутній файл для прибирання після збою.
      // Успішна транзакція прибере цей запис; невдала залишить його на годину.
      await pool.query("INSERT INTO avatar_cleanup_jobs (object_key, available_at) VALUES ($1, now() + interval '1 hour')", [key]);
      const connection = await pool.connect();
      let transactionOpen = false;
      try {
        await connection.query('BEGIN');
        transactionOpen = true;
        await connection.query("SET LOCAL lock_timeout = '5s'");
        await connection.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
        const locked = await connection.query('SELECT id, avatar_key, avatar_upload_key FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const current = locked.rows[0];
        if (!current) throw new AvatarError(401, 'Користувача не знайдено. Увійдіть повторно.');
        if (current.avatar_upload_key === pendingKey && current.avatar_key) {
          const avatar = await storage.readUrl(current.avatar_key);
          await connection.query('COMMIT');
          transactionOpen = false;
          return avatar;
        }

        await storage.saveVerified(key, jpeg);
        const avatar = await storage.readUrl(key);
        await connection.query('UPDATE users SET avatar_key = $1, avatar_upload_key = $2 WHERE id = $3', [key, pendingKey, userId]);
        await connection.query('DELETE FROM avatar_cleanup_jobs WHERE object_key = $1', [key]);
        // Черга прибирання зберігається разом із новим ключем, а не лише в пам'яті.
        for (const obsolete of [pendingKey, current.avatar_key].filter(Boolean)) {
          await connection.query('INSERT INTO avatar_cleanup_jobs (object_key) VALUES ($1) ON CONFLICT DO NOTHING', [obsolete]);
        }
        await connection.query('COMMIT');
        transactionOpen = false;
        return avatar;
      } catch (error) {
        if (transactionOpen) await connection.query('ROLLBACK').catch(() => {});
        // Не видаляємо новий файл тут: при втраті з'єднання COMMIT міг відбутися.
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
module.exports = createAvatarService;
