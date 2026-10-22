const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  res.set('Cache-Control', 'no-store');

  const authorization = req.get('Authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);

  if (!match) {
    return res.status(401).json({ error: 'Потрібна авторизація.' });
  }

  let payload;
  try {
    payload = jwt.verify(match[1], process.env.JWT_SECRET, {
      algorithms: ['HS256'],
    });
  } catch {
    return res.status(401).json({ error: 'Сесія недійсна або завершилася. Увійдіть повторно.' });
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    !Number.isSafeInteger(payload.userId) ||
    payload.userId <= 0 ||
    !Number.isSafeInteger(payload.exp)
  ) {
    return res.status(401).json({ error: 'Сесія недійсна. Увійдіть повторно.' });
  }

  // Особу користувача беремо лише з перевіреного токена.
  req.user = { id: payload.userId };
  next();
}

module.exports = authMiddleware;
