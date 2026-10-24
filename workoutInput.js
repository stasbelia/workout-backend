const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['title', 'date', 'notes', 'clientRequestId'].includes(key))) return null;
  const { title, date, clientRequestId } = body;
  const notes = body.notes === undefined ? '' : body.notes;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 100 || /\p{Cc}/u.test(title) ||
      !isDate(date) || typeof notes !== 'string' || notes.trim().length > 500 ||
      /[^\P{Cc}\n\t]/u.test(notes) || typeof clientRequestId !== 'string' || !UUID.test(clientRequestId)) return null;
  return { title: title.trim(), date, notes: notes.trim(), clientRequestId };
}

module.exports = { isDate, parseBody };
