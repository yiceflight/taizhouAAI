const REALTIME_URL = 'https://aai.airins.cn/sniff/Realtime';

const visible = (element) => element?.getClientRects?.().length > 0
  && getComputedStyle(element).visibility !== 'hidden'
  && getComputedStyle(element).display !== 'none';

// The Realtime page renders the parameter list as Vue elements rather than
// stable links. Match the visible label and click its nearest interactive row.
export function selectAirinsPm25() {
  const normalize = (value) => value.replace(/[₂]/g, '2').replace(/[₅]/g, '5').replace(/\s+/g, ' ').trim();
  const candidates = [...document.querySelectorAll('button,[role="button"],li,div,span')]
    .filter(visible)
    .filter((element) => /^PM2[._\s-]*5(?:\s*\(.*\))?$/i.test(normalize(element.textContent || '')))
    .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
  const target = candidates[0];
  if (!target) return { selected: false, label: null };
  const clickable = target.closest('button,[role="button"],li') || target;
  clickable.click();
  return { selected: true, label: (target.textContent || '').trim().slice(0, 80) };
}

export { REALTIME_URL };
