// Serialized into the report-owned media tab. Read only the displayed photo
// and its annotation layers; never infer temperature from image colours.
export async function djiPhotoPresentation(job) {
  const marker = 'data-taizhou-photo-capture';
  if (job.phase === 'restore') {
    for (const el of document.querySelectorAll(`[${marker}]`)) {
      const saved = JSON.parse(el.getAttribute(marker));
      if (saved.id !== job.captureId) continue;
      if (saved.style === null) el.removeAttribute('style');
      else el.setAttribute('style', saved.style);
      el.removeAttribute(marker);
    }
    return null;
  }
  const visible = el => {
    if (!el || !el.getClientRects().length) return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const stem = job.name.replace(/\.(jpe?g|png)$/i, '');
  const candidates = [...document.querySelectorAll('.photo-wrapper')].filter(el => visible(el)
    && el.closest('.detail-content')?.querySelector('.photo-name')?.textContent.trim() === stem);
  if (candidates.length !== 1) throw new Error('司空照片预览尚未与当前文件对应，未保存缺少标注的图片');
  const photo = candidates[0], detail = photo.closest('.detail-content');
  if (document.fonts?.status === 'loading' || [...detail.querySelectorAll('.ant-spin-spinning')].some(visible)) throw new Error('司空照片或标注仍在加载');
  const img = photo.querySelector('.viewer-canvas > img');
  const doodles = photo.querySelector('.doodle-list-container');
  if (!visible(img) || !img.complete || !img.naturalWidth || !doodles) throw new Error('司空照片或标注图层尚未加载完成');
  if (img.naturalWidth !== job.width || img.naturalHeight !== job.height) throw new Error('司空预览不是本张完整尺寸照片，未保存不完整标注图');
  const rect = img.getBoundingClientRect(), frame = photo.getBoundingClientRect();
  const inside = (a, b) => a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1;
  if (rect.width <= 0 || rect.height <= 0 || !inside(rect, frame)
      || !inside(rect, {left: 0, top: 0, right: innerWidth, bottom: innerHeight})
      || Math.abs(rect.width / rect.height - job.width / job.height) > 0.002) {
    throw new Error('司空照片被缩放、旋转或裁切，请恢复完整照片后重试');
  }
  const layers = [doodles, photo.querySelector('.hotspot-wrapper')].filter(Boolean);
  const marks = [...doodles.children].filter(visible);
  const tagRow = detail.parentElement?.querySelector('.detail-desc-tag-row');
  const expectedText = tagRow?.querySelector('.tag-sum')?.textContent.trim();
  // FlightHub renders an empty, mounted tag row for zero tags (no "0" badge).
  // A missing row or an unrecognized nonempty row is still an unknown count.
  const emptyRow = tagRow && tagRow.children.length === 0 && !tagRow.textContent.trim();
  const expected = expectedText && /^\d+$/.test(expectedText) ? Number(expectedText) : emptyRow ? 0 : null;
  if (expected === null) throw new Error('尚未取得司空标注数量，无法确认标注完整性');
  if (marks.length !== expected || marks.length !== doodles.children.length) throw new Error('司空标注数量与页面记录不一致，请等待全部标注显示后重试');
  if (!visible(doodles)) throw new Error('司空标注被隐藏，未保存缺少标注的图片');
  const hotspots = [...(layers[1]?.querySelector('.uranus-hot-spot-container-wrapper')?.children ?? [])].filter(visible);
  if (hotspots.length !== (layers[1]?.querySelector('.uranus-hot-spot-container-wrapper')?.children.length ?? 0)) throw new Error('司空热点标注被隐藏，未保存缺少标注的图片');
  const annotationCount = marks.length + hotspots.length;
  if (annotationCount > 1000) throw new Error('单张照片标注超过 1000 项');
  const labels = [...doodles.querySelectorAll('.text'), ...hotspots].filter(visible)
    .map(el => el.textContent.trim()).filter(Boolean);
  // Measure painted content rather than the 24px point-icon layout box that
  // surrounds FlightHub's 16px SVG. Ignore empty SVG/canvas layout boxes.
  const painted = [];
  for (const layer of layers) for (const el of layer.querySelectorAll('.text, .point-icon, svg, canvas')) {
    if (!visible(el) || (el.matches('.point-icon') && el.querySelector('svg,canvas'))) continue;
    const box = el.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) painted.push(box);
  }
  const density = job.width / rect.width;
  const padding = {left: 0, top: 0, right: 0, bottom: 0};
  for (const box of painted) {
    // Leave room for the site's white text outline and SVG edge antialiasing.
    padding.left = Math.max(padding.left, Math.ceil((rect.left - box.left + 2) * density));
    padding.top = Math.max(padding.top, Math.ceil((rect.top - box.top + 2) * density));
    padding.right = Math.max(padding.right, Math.ceil((box.right - rect.right + 2) * density));
    padding.bottom = Math.max(padding.bottom, Math.ceil((box.bottom - rect.bottom + 2) * density));
  }
  const geometry = job.phase === 'capture-inspect' ? job.captureGeometry : {
    width: job.width + padding.left + padding.right, height: job.height + padding.top + padding.bottom,
    imageRect: {x: padding.left, y: padding.top, width: job.width, height: job.height},
  };
  if (!geometry || geometry.width > job.width * 3 || geometry.height > job.height * 3
      || geometry.width * geometry.height > 100000000) throw new Error('照片标注范围异常，无法完整合成');
  // CDP's output pixel ratio can differ from window.devicePixelRatio. Measure
  // it from an initial capture rather than assuming Retina/browser zoom rules.
  const clip = {x: rect.x + scrollX - geometry.imageRect.x / density,
    y: rect.y + scrollY - geometry.imageRect.y / density,
    width: geometry.width / density, height: geometry.height / density, scale: 1};
  if (job.phase === 'capture-inspect') {
    // DOM transforms can yield -1e-14 at an edge that is mathematically zero.
    if (clip.x < 0 && clip.x > -0.001) clip.x = 0;
    if (clip.y < 0 && clip.y > -0.001) clip.y = 0;
    const area = {left: clip.x - scrollX, top: clip.y - scrollY,
      right: clip.x - scrollX + clip.width, bottom: clip.y - scrollY + clip.height};
    if (!inside(area, {left: 0, top: 0, right: innerWidth, bottom: innerHeight})
        || painted.some(box => !inside(box, area))) throw new Error('标注画面未完整进入合成区域，请重试');
  }
  const appearance = layers.flatMap(layer => [layer, ...layer.querySelectorAll('*')]).map(el => {
    const style = getComputedStyle(el), box = el.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height, style.visibility, style.opacity, style.color,
      style.fill, style.stroke, style.font, style.textShadow, style.transform];
  });
  const signatureBytes = new TextEncoder().encode(JSON.stringify({
    name: stem, image: img.currentSrc || img.src, clip, expected,
    layers: layers.map(el => el.outerHTML), appearance,
  }));
  const signature = [...new Uint8Array(await crypto.subtle.digest('SHA-256', signatureBytes))]
    .map(v => v.toString(16).padStart(2, '0')).join('');
  if (job.signature && job.signature !== signature) throw new Error('司空照片或标注在保存期间发生变化，请重试');
  if (job.phase === 'prepare') {
    if (!/^[a-f0-9-]{36}$/.test(job.captureId)) throw new Error('照片合成任务编号无效');
    const saveStyle = el => {
      if (!el.hasAttribute(marker)) el.setAttribute(marker, JSON.stringify({id: job.captureId, style: el.getAttribute('style')}));
    };
    const hide = el => {
      if (!visible(el)) return;
      // FlightHub keeps #ai-point in a zero-size SVG sprite under <body>.
      // Hiding that resource also hides every visible <use> of its symbols.
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0 && el.querySelector('symbol,defs')) return;
      saveStyle(el);
      el.style.setProperty('visibility', 'hidden', 'important');
    };
    // Keep layout and the site's own SVG/text rendering unchanged. Hide only
    // surrounding UI (including banners that can cover the photo's top edge).
    for (let node = photo; node && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement?.children ?? []) if (sibling !== node) hide(sibling);
    }
    for (const el of photo.children) if (!el.matches('.viewer-js-container,.doodle-list-container,.hotspot-wrapper')) hide(el);
    for (const el of photo.querySelectorAll('.viewer-footer,.viewer-tooltip,.viewer-button')) hide(el);
    if (geometry.width !== job.width || geometry.height !== job.height) {
      // Uniformly fit the entire photo + annotations into the existing frame.
      // Only local presentation styles change: no reparenting, DOM cloning or
      // changes to the site's saved annotations. Original pixel density is
      // restored by the worker's screenshot scale.
      const scale = Math.min(1, frame.width / clip.width, frame.height / clip.height);
      const x = (frame.width - clip.width * scale) / 2 - (clip.x - scrollX - frame.left) * scale;
      const y = (frame.height - clip.height * scale) / 2 - (clip.y - scrollY - frame.top) * scale;
      saveStyle(photo);
      photo.style.setProperty('transition', 'none', 'important');
      photo.style.setProperty('transform-origin', '0 0', 'important');
      photo.style.setProperty('transform', `translate(${x}px, ${y}px) scale(${scale})`, 'important');
      for (const el of [photo, ...layers]) {
        saveStyle(el);
        el.style.setProperty('overflow', 'visible', 'important');
      }
    }
    const captured = await djiPhotoPresentation({...job, phase: 'capture-inspect', signature: null, captureGeometry: geometry});
    return {...captured, sourceSignature: signature};
  }
  return {method: 'dji-viewer-capture-v2', ...geometry, annotationCount, labels, clip, signature};
}

// Worker-side capture stays on the attached, report-owned tab. The source
// JPEG remains untouched; the PNG is a separate presentation of the same photo.
export async function captureDjiPresentation(api, tabId, job, plan, inspect, uuid = () => crypto.randomUUID(), timeoutMs = 15000, normalize = normalizeDjiCapture) {
  const target = {tabId}, captureId = uuid();
  const command = async (method, params, timeout = timeoutMs) => {
    let timer;
    try {
      return await Promise.race([api.sendCommand(target, method, params), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('司空标注合成超时，未保存缺少标注的图片')), timeout);
      })]);
    } finally { clearTimeout(timer); }
  };
  const evaluate = async (phase, extra = {}) => {
    const response = await command('Runtime.evaluate', {
      expression: `(${inspect.toString()})(${JSON.stringify({...job, ...plan,
        width: plan.imageRect?.width ?? plan.width, height: plan.imageRect?.height ?? plan.height, phase, captureId, ...extra})})`,
      awaitPromise: true, returnByValue: true,
    }, phase === 'restore' ? Math.min(timeoutMs, 2000) : timeoutMs);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || '司空标注画面校验失败');
    return response.result?.value;
  };
  const metadata = {method: plan.method, width: plan.width, height: plan.height,
    imageRect: plan.imageRect, annotationCount: plan.annotationCount, labels: plan.labels, capturedAt: Date.now(), dataUrl: null};
  try {
    await command('Emulation.setFocusEmulationEnabled', {enabled: true});
    const prepared = await evaluate(plan.annotationCount ? 'prepare' : 'inspect');
    if (!prepared || (plan.annotationCount ? prepared.sourceSignature : prepared.signature) !== plan.signature
        || prepared.width !== plan.width || prepared.height !== plan.height) throw new Error('司空标注画面校验失败');
    if (plan.annotationCount) {
      const dimensions = data => {
        if (!data || data.length > 48000000) throw new Error('标注合成图为空或超过捕获限制');
        const header = Uint8Array.from(atob(data.slice(0, 32)), c => c.charCodeAt(0));
        const view = new DataView(header.buffer);
        if (header.length !== 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a
            || view.getUint32(12) !== 0x49484452) throw new Error('标注合成图不是有效 PNG');
        const width = view.getUint32(16), height = view.getUint32(20);
        if (!width || !height || width * height > 100000000) throw new Error('标注合成图尺寸无效');
        return {data, width, height};
      };
      const take = async scale => dimensions((await command('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true, clip: {...prepared.clip, scale},
      })).data);
      let result = await take(1);
      // A uniform scale mismatch is a browser pixel-ratio difference. A
      // different aspect ratio indicates clipping and must still fail closed.
      if (Math.abs(result.width - result.height * prepared.clip.width / prepared.clip.height) > 2) {
        throw new Error('标注合成图比例与照片区域不符，未保存裁切图');
      }
      if (result.width !== plan.width || result.height !== plan.height) result = await take(plan.width / result.width);
      if (result.width !== plan.width || result.height !== plan.height) {
        // Fractional CSS bounds are rounded by Chrome before/after scaling.
        // Normalize only this tiny rounding error, never enlarge a thumbnail.
        if (Math.abs(result.width - plan.width) > 2 || Math.abs(result.height - plan.height) > 2) {
          throw new Error(`标注合成图尺寸与原图不符（${result.width}×${result.height} / ${plan.width}×${plan.height}），未保存裁切或缩略图`);
        }
        result = dimensions(await normalize(result.data, plan.width, plan.height));
        if (result.width !== plan.width || result.height !== plan.height) throw new Error('标注合成图像素尺寸校正失败');
      }
      if (result.data.length > 16000000) throw new Error('标注合成图超过 12 MB，未退回无标注原图');
      const verified = await evaluate('capture-inspect', {signature: prepared.signature,
        captureGeometry: {width: prepared.width, height: prepared.height, imageRect: prepared.imageRect}});
      if (!verified || verified.signature !== prepared.signature) throw new Error('司空标注画面在合成时发生变化');
      metadata.dataUrl = `data:image/png;base64,${result.data}`;
    }
    return metadata;
  } finally {
    try { await evaluate('restore'); }
    finally { await command('Emulation.setFocusEmulationEnabled', {enabled: false}, Math.min(timeoutMs, 2000)).catch(() => {}); }
  }
}

// Service-worker canvas: keep the entire captured image and all its annotations
// when normalizing Chrome's at-most-two-pixel rounding difference.
export async function normalizeDjiCapture(data, width, height) {
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法校正标注合成图尺寸');
    context.drawImage(bitmap, 0, 0, width, height);
    const output = new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer());
    if (output.length > 12000000) throw new Error('标注合成图超过 12 MB');
    let binary = '';
    for (let i = 0; i < output.length; i += 32768) binary += String.fromCharCode(...output.subarray(i, i + 32768));
    return btoa(binary);
  } finally { bitmap.close(); }
}
