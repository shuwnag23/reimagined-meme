/*
 * Default data for the first opening only.
 * After that, use admin.html to manage product pools, card codes, and inventory.
 */
window.PICKUP_CONFIG = {
  siteName: "取件站",
  siteTagline: "数字商品文件领取中心",
  notice: "每个兑换码只能兑换一次；批量取件时请每行输入一个兑换码。",
  products: [
    {
      codes: ["DEMO-2026"],
      title: "示例商品文件",
      subtitle: "用于验证网页流程的示例内容",
      category: "数字文件",
      inventory: [
        {
          id: "demo-stock-001",
          name: "商品说明.txt",
          path: "products/商品说明.txt",
          type: "TXT",
          size: "1 KB"
        }
      ]
    }
  ]
};
