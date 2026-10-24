const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseSets(sets) {
  if (!Array.isArray(sets) || sets.length < 1 || sets.length > 30) return null;
  const result = [];
  for (const set of sets) {
    if (!set || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).some((key) => !['reps', 'weightKg'].includes(key)) ||
        !Number.isInteger(set.reps) || set.reps < 1 || set.reps > 1000) return null;
    const weight = set.weightKg === undefined ? null : set.weightKg;
    if (weight !== null && (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1000 ||
        Math.abs(weight * 100 - Math.round(weight * 100)) > 1e-8)) return null;
    result.push({ reps: set.reps, weightKg: weight === null ? null : Math.round(weight * 100) / 100 });
  }
  return result;
}

function parseBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['name', 'notes', 'clientRequestId', 'sets'].includes(key))) return null;
  const notes = body.notes === undefined ? '' : body.notes;
  const sets = parseSets(body.sets);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100 || /\p{Cc}/u.test(body.name) ||
      typeof notes !== 'string' || notes.trim().length > 500 || /[^\P{Cc}\n\t]/u.test(notes) ||
      typeof body.clientRequestId !== 'string' || !UUID.test(body.clientRequestId) || !sets) return null;
  return { name: body.name.trim(), notes: notes.trim(), clientRequestId: body.clientRequestId, sets };
}

module.exports = { parseBody };
