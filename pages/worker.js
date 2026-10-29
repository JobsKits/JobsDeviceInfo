/* JobsDeviceInfo · Created by Jobs. */

export default {
  async fetch(request, env) {
    try {
      // 保留原始地址和请求体，让二维码、Cookie 与系统回调继续使用当前入口。
      return await env.DEVICE_SERVICE.fetch(request);
    } catch {
      return Response.json({
        ok: false,
        error: { code: 'service_unavailable', message: '采集服务暂不可用，请稍后重试。' }
      }, {
        status: 503,
        headers: { 'Cache-Control': 'no-store, max-age=0' }
      });
    }
  }
};
