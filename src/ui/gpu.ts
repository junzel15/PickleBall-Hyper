// One GPU device for every 3D view (court players, customize showcase): cheaper than one each,
// and three.js's WebGPU renderer is happiest sharing a device.
let devicePromise: Promise<GPUDevice> | null = null;

export function getGpuDevice(): Promise<GPUDevice> {
  if (!devicePromise) {
    devicePromise = (async () => {
      const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
      if (!gpu) throw new Error('WebGPU is not available');
      const adapter = await gpu.requestAdapter();
      if (!adapter) throw new Error('No GPU adapter');
      const device = await adapter.requestDevice();
      device.lost.then(() => { devicePromise = null; }); // a new one is made next time
      return device;
    })();
    devicePromise.catch(() => { devicePromise = null; });
  }
  return devicePromise;
}
