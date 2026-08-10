/**
 * Нарезка большой картинки карты на тайлы — прямо в браузере.
 *
 * Зачем так: карта на 150 МБ одним файлом бесполезна. Браузер держал бы в
 * памяти распакованный растр (16000×16000 — это больше гигабайта), а панели для
 * нарезки понадобился бы декодер картинок, которого в ней нет и ради одной
 * операции заводить не хочется. Браузер же умеет и читать JPEG, и масштабировать
 * его аппаратно — поэтому режет он, а панель только складывает готовые тайлы.
 *
 * Схема нарезки — обычная XYZ: на уровне z карта занимает 2^z тайлов по каждой
 * оси, тайл 256×256, строка y=0 — север. Ровно это ждёт код отрисовки карты.
 */

const TILE = 256;

/** Дальше нарезать смысла нет: 2^6 = 64 тайла в ряд, 16384 пикселя на карту. */
const MAX_ZOOM = 6;

/**
 * @param {File|Blob} file картинка карты
 * @param {object} opts
 * @param {string} opts.layer «topographic» или «satellite»
 * @param {number} opts.maxZoom до какого уровня резать
 * @param {(done: number, total: number, note: string) => void} opts.onProgress
 * @param {(layer: string, z: number, x: number, y: number, blob: Blob) => Promise} opts.upload
 * @returns {Promise<{zooms: number, tiles: number, width: number, height: number, bytes: number}>}
 */
export async function sliceMapImage(file, opts) {
  const layer = opts.layer === 'satellite' ? 'satellite' : 'topographic';
  const onProgress = opts.onProgress || (() => {});

  if (typeof createImageBitmap !== 'function') {
    throw new Error('браузер не умеет createImageBitmap — обновите его или возьмите картинку поменьше');
  }

  onProgress(0, 1, 'читаю картинку');

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (err) {
    throw new Error(
      `браузер не смог открыть эту картинку (${err.message || 'слишком большая'}). ` +
        'Уменьшите её, например до 8192×8192 — для карты этого более чем достаточно'
    );
  }

  const { width, height } = bitmap;
  if (!width || !height) throw new Error('не удалось определить размеры картинки');

  // Мир квадратный: если картинка не квадратная, метки поедут. Резать всё равно
  // будем — предупреждение показывает вызывающий код.
  const side = Math.min(width, height);

  // Больше уровней, чем есть пикселей, делать бессмысленно: тайлы вышли бы
  // растянутыми копиями одного и того же.
  const natural = Math.ceil(Math.log2(Math.max(1, side / TILE)));
  const maxZoom = Math.max(0, Math.min(MAX_ZOOM, opts.maxZoom === undefined ? natural : opts.maxZoom, natural));

  let total = 0;
  for (let z = 0; z <= maxZoom; z++) total += 4 ** z;

  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  let done = 0;
  let bytes = 0;
  let tiles = 0;

  for (let z = 0; z <= maxZoom; z++) {
    const span = 2 ** z;
    // Сколько пикселей исходника приходится на один тайл этого уровня.
    const sourceStep = { x: width / span, y: height / span };

    for (let y = 0; y < span; y++) {
      for (let x = 0; x < span; x++) {
        ctx.clearRect(0, 0, TILE, TILE);
        ctx.drawImage(
          bitmap,
          x * sourceStep.x,
          y * sourceStep.y,
          sourceStep.x,
          sourceStep.y,
          0,
          0,
          TILE,
          TILE
        );

        const blob = await toBlob(canvas);
        await opts.upload(layer, z, x, y, blob);

        bytes += blob.size;
        tiles++;
        done++;

        // Не после каждого тайла: обновление текста на каждой из тысячи итераций
        // само по себе тормозит браузер.
        if (done % 8 === 0 || done === total) onProgress(done, total, `уровень ${z}`);
      }
    }
  }

  if (bitmap.close) bitmap.close();
  return { zooms: maxZoom + 1, tiles, width, height, bytes };
}

/** canvas -> Blob. JPEG для тайлов заметно меньше PNG, а карта не схема. */
function toBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('браузер не отдал тайл'))), 'image/jpeg', 0.82)
  );
}
