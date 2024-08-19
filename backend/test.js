// console.log("[global.tjs.engine]", global.tjs.engine.gc.enabled);
// global.tjs.engine.gc.threshold = 100;
// console.log("[global.tjs.engine]", global.tjs.engine.gc.threshold);

function runGCTests() {
  let objects = [];
  for (let i = 0; i < 100000; i++) {
    objects[i] = { index: i, data: new Array(1000).fill(i) };
  }
  objects = null; // Dereference the objects to make them eligible for garbage collection
}

runGCTests();
setInterval(() => {
  if (global.tjs) {
    console.log("[global.tjs.engine]", global.tjs.engine.gc.run());
  }
}, 3000);
setTimeout(() => {}, 1000000);
// 168064
