export const serverUrl =
  import.meta.env.MODE === "development"
    ? "//localhost:3000"
    : "//webfontserverless.shenzilong.cn";
