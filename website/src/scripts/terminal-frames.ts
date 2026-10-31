const VISIBLE_SHARE_TO_PLAY = 0.5;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

for (const frame of document.querySelectorAll<HTMLElement>(
  "[data-terminal-frame]",
)) {
  const video = frame.querySelector("video");
  const toggle = frame.querySelector<HTMLButtonElement>(
    "[data-terminal-toggle]",
  );
  if (!video || !toggle) continue;

  let pausedByVisitor = reducedMotion.matches;
  let inView = false;

  const showState = (): void => {
    toggle.textContent = video.paused ? "Play recording" : "Pause recording";
  };
  const playIfWanted = (): void => {
    if (inView && !pausedByVisitor) void video.play().catch(showState);
    else video.pause();
  };

  video.removeAttribute("controls");
  toggle.hidden = false;
  video.addEventListener("play", showState);
  video.addEventListener("pause", showState);
  toggle.addEventListener("click", () => {
    pausedByVisitor = !video.paused;
    if (pausedByVisitor) video.pause();
    else void video.play().catch(showState);
  });

  new IntersectionObserver(
    ([entry]) => {
      inView = entry.intersectionRatio >= VISIBLE_SHARE_TO_PLAY;
      playIfWanted();
    },
    { threshold: VISIBLE_SHARE_TO_PLAY },
  ).observe(frame);
}
