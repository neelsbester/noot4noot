const variants = [...document.querySelectorAll(".variant")];
const reduceMotion = document.querySelector("#reduce-motion");

function play(variant, delay = 0) {
  window.setTimeout(() => {
    variant.classList.remove("is-playing");
    void variant.offsetWidth;
    variant.classList.add("is-playing");
  }, delay);
}

function playAll() {
  variants.forEach((variant, index) => play(variant, index * 70));
}

for (const variant of variants) {
  variant.querySelector(".replay").addEventListener("click", () => play(variant));
}

document.querySelector("#play-all").addEventListener("click", playAll);
document.querySelector("#play-all-footer").addEventListener("click", playAll);
reduceMotion.addEventListener("change", () => {
  document.documentElement.classList.toggle("reduce-motion", reduceMotion.checked);
  playAll();
});

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting && !entry.target.dataset.played) {
      entry.target.dataset.played = "true";
      play(entry.target, 120);
    }
  }
}, { threshold: 0.45 });

variants.forEach((variant) => observer.observe(variant));
window.setTimeout(playAll, 300);
