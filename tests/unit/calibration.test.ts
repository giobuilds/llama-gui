import assert from 'node:assert/strict'
import { addSample, derive, EMPTY_CALIBRATION, type Calibration } from '../../src/main/calibration.js'
let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}
const S=(activeBytes:number, tps:number, onGpu=true)=>({activeBytes, secondsPerToken:1/tps, onGpu, at:Date.now()})
const add=(c:Calibration,...ss:ReturnType<typeof S>[])=>ss.reduce((acc,x)=>addSample(acc,x),c)

console.log('nothing measured yet')
const empty=derive(EMPTY_CALIBRATION)
assert.equal(empty.gpuBytesPerSecond,null); assert.equal(empty.cpuBytesPerSecond,null)
ok('claims no bandwidth before any measurement')

console.log('one sample gives bandwidth but no ceiling')
const one=derive(add(EMPTY_CALIBRATION, S(1.93e9, 94.7)))
assert.ok(Math.abs(one.gpuBytesPerSecond!-182.8e9)/182.8e9 < 0.01)
ok(`one sample -> ${(one.gpuBytesPerSecond!/1e9).toFixed(0)} GB/s`)
assert.equal(one.ceilingTokensPerSecond,null)
ok('but no ceiling, since overhead cannot be separated from one point')

console.log('two sizes separate bandwidth from per-token overhead')
// Real measurements from this machine: a 1.93 GB model at 94.7 tok/s and a
// 0.49 GB model at 324.7 tok/s.
const two=derive(add(EMPTY_CALIBRATION, S(1.93e9,94.7), S(0.4914e9,324.7)))
console.log(`   fitted: ${(two.gpuBytesPerSecond!/1e9).toFixed(0)} GB/s, ceiling ${two.ceilingTokensPerSecond?Math.round(two.ceilingTokensPerSecond):'none'} tok/s`)
assert.ok(two.gpuBytesPerSecond! > 150e9 && two.gpuBytesPerSecond! < 260e9)
ok('bandwidth in a believable range for this card')
assert.equal(two.ceilingTokensPerSecond, null)
ok('no ceiling claimed from two points, which cannot constrain an intercept')

console.log('three sizes spanning a range do give a ceiling')
// Real measurements: 1.93 GB at 94.7, 0.49 GB at 324.7, 0.088 GB at 633.3 tok/s.
const three=derive(add(EMPTY_CALIBRATION, S(1.93e9,94.7), S(0.4914e9,324.7), S(0.0882e9,633.3)))
console.log(`   fitted: ${(three.gpuBytesPerSecond!/1e9).toFixed(0)} GB/s, ceiling ${Math.round(three.ceilingTokensPerSecond!)} tok/s`)
assert.ok(three.ceilingTokensPerSecond! > 500 && three.ceilingTokensPerSecond! < 1400,
  `ceiling ${three.ceilingTokensPerSecond}`)
ok(`ceiling near the measured plateau (${Math.round(three.ceilingTokensPerSecond!)} tok/s vs ~630 observed)`)
for (const [bytes,tps] of [[1.93e9,94.7],[0.4914e9,324.7]] as const) {
  const pred = 1/(1/three.ceilingTokensPerSecond! + bytes/three.gpuBytesPerSecond!)
  assert.ok(Math.abs(pred-tps)/tps < 0.25, `predicted ${pred.toFixed(0)} vs ${tps}`)
}
ok('and the fitted line reproduces the larger measurements')

console.log('GPU and CPU are tracked separately')
const both=derive(add(EMPTY_CALIBRATION, S(1.93e9,94.7,true), S(1.93e9,11.6,false)))
assert.ok(both.gpuBytesPerSecond! > both.cpuBytesPerSecond!*5)
ok(`GPU ${(both.gpuBytesPerSecond!/1e9).toFixed(0)} GB/s vs CPU ${(both.cpuBytesPerSecond!/1e9).toFixed(0)} GB/s`)
assert.equal(both.gpuSamples,1); assert.equal(both.cpuSamples,1)
ok('sample counts reported per device')

console.log('the fastest result at a size wins')
const contended=add(EMPTY_CALIBRATION, S(1.93e9,94.7), S(1.93e9,40))
assert.ok(derive(contended).gpuBytesPerSecond! > 170e9)
ok('a slow sample at the same size is treated as contention, not a slower machine')
assert.equal(contended.samples.length,1); ok('and does not accumulate duplicates')

console.log('nonsense is refused rather than fitted')
const backwards=derive(add(EMPTY_CALIBRATION, S(1e9,100), S(2e9,200)))
assert.ok(backwards.gpuBytesPerSecond! > 0)
assert.equal(backwards.ceilingTokensPerSecond,null)
ok('samples implying bigger-is-faster fall back to the best point, with no ceiling')

console.log('samples stay bounded')
let many=EMPTY_CALIBRATION
for (let i=1;i<=30;i++) many=addSample(many, S(0.5e9*i, 300/i))
assert.ok(many.samples.length<=12); ok(`kept ${many.samples.length} samples, not 30`)

console.log(`\n${n} assertions passed`)
