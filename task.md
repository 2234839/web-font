/loop 持续优化字体子集化性能，可以大胆放开手脚的去做，但是优化完一定要通过`pnpx tsx ./基准测试.test.ts`。中途不要切换到其他模式，比如计划模式也不要询问我，你直接做就行了，请你持续的去优化，不要去询问我，不要去中断，好吧

把基准测试结果文档保存在本地 benchmark_results/ ，这样我方便查看。你的文档中应该在每个重大节点更新基准测试结果（benchmark_results/OPTIMIZATION_LOG.md），这样我能方便看到你使用了哪些优化方法，得到了什么样的优化效果。



=== 字体裁剪基准测试 ===

  8个汉字: avg=23.6ms  min=18.4ms  max=37.2ms  输出=16,508 bytes  ssim=1.0000
  拉丁+数字: avg=16.4ms  min=13.7ms  max=18.2ms  输出=1,272 bytes  ssim=1.0000
  千字文前段: avg=59.4ms  min=47.3ms  max=76.5ms  输出=161,344 bytes  ssim=1.0000
