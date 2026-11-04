# rust 后端（musl 静态二进制）+ vite-ssg 前端静态资源，FROM scratch 无基础镜像
# 镜像内容 = webfont-rs(约2.2MB) + dist/，构建链见 package.json release 脚本：
#   pnpm build（vite-ssg → dist/）
#   pnpm build_backend_rs（cargo musl 静态编译 → dist_backend/webfont-rs）
FROM scratch
WORKDIR /home/
COPY dist_backend/webfont-rs /home/webfont-rs
COPY dist/ /home/dist/
# 服务器 compose 映射 8087:8087（compose 不可改），容器内固定监听 8087
ENV PORT=8087
EXPOSE 8087
CMD ["/home/webfont-rs"]
