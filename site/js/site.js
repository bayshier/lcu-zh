(() => {
  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Theme toggle (dark by default; the choice is kept in localStorage)
  const toggle = document.querySelector('.theme-toggle');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const syncTheme = () => {
    const light = root.dataset.theme === 'light';
    toggle.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    themeMeta.content = light ? '#FBFBFD' : '#050608';
  };
  toggle.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('lcu-theme', root.dataset.theme); } catch (e) {}
    syncTheme();
  });
  syncTheme();

  // Showreel: muted ambient loop, with an explicit "play with sound" control.
  const video = document.getElementById('reel');
  const sound = document.querySelector('.reel-sound');
  const soundLabel = sound.querySelector('.reel-sound-label');
  const figure = video.closest('.reel');
  let userStarted = false;

  const setSoundUI = () => {
    const withSound = !video.muted && !video.paused;
    sound.setAttribute('aria-pressed', String(withSound));
    soundLabel.textContent = withSound ? 'Mute' : video.muted ? 'Play with sound' : 'Play';
  };
  const showControls = () => {
    video.controls = true;
    figure.classList.add('has-controls');
  };

  sound.hidden = false;
  if (reduceMotion.matches) {
    // No autoplay: keep the poster and native controls.
    figure.classList.add('has-controls');
  } else {
    video.controls = false;
    const tryPlay = () => video.play().catch(showControls);
    // Play only while visible, until the user takes over.
    new IntersectionObserver(([entry]) => {
      if (userStarted) return;
      if (entry.isIntersecting) tryPlay();
      else video.pause();
    }, { threshold: 0.25 }).observe(video);
  }

  sound.addEventListener('click', () => {
    const first = !userStarted;
    userStarted = true;
    if (!video.muted && !video.paused) {
      video.muted = true;
    } else {
      if (first) video.currentTime = 0;
      video.muted = false;
      video.loop = false;
      showControls();
      video.play().catch(() => {});
    }
    setSoundUI();
  });
  ['play', 'pause', 'volumechange'].forEach(e => video.addEventListener(e, setSoundUI));
  video.addEventListener('play', () => { if (video.controls) userStarted = true; });
  setSoundUI();

  // Copy buttons
  const status = document.getElementById('copy-status');
  document.querySelectorAll('[data-copy]').forEach(button => {
    button.addEventListener('click', async () => {
      const text = document.getElementById(button.dataset.copy).innerText.trim();
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (e) {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById(button.dataset.copy));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand && document.execCommand('copy');
      }
      button.textContent = ok ? 'Copied' : 'Selected';
      button.classList.toggle('done', ok);
      status.textContent = ok ? 'Prompt copied to clipboard.' : 'Prompt selected. Copy it with your keyboard.';
      clearTimeout(button._t);
      button._t = setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('done');
      }, 2000);
    });
  });

  // Scroll reveal
  const items = document.querySelectorAll('.reveal');
  if (reduceMotion.matches || !('IntersectionObserver' in window)) {
    items.forEach(el => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(el => io.observe(el));
  }
})();
