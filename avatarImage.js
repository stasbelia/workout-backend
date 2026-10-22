const sharp = require('sharp');
const AvatarError = require('./avatarErrors');
const { MAX_AVATAR_BYTES } = require('./avatarStorage');

async function normalizeAvatar(bytes) {
  const invalid = () => new AvatarError(400, 'Потрібне справжнє непошкоджене фото JPEG або PNG до 5 МіБ та 4096 × 4096 пікселів.');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_AVATAR_BYTES) throw invalid();
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!jpeg && !png) throw invalid();
  try {
    const image = sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: 'warning' });
    const meta = await image.metadata();
    if (!['jpeg', 'png'].includes(meta.format) || !meta.width || !meta.height ||
        meta.width > 4096 || meta.height > 4096 || (meta.pages || 1) > 1) throw invalid();
    // Повне декодування й новий JPEG; EXIF/GPS та довільні додаткові дані не копіюються.
    return await image.rotate().resize(512, 512, { fit: 'cover', withoutEnlargement: true })
      .jpeg({ quality: 85 }).timeout({ seconds: 5 }).toBuffer();
  } catch {
    throw invalid();
  }
}
module.exports = normalizeAvatar;
