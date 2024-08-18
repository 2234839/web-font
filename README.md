# web font 字体裁剪工具

之前的版本请查看 master 分支，为了能使用 llrt ，我进行了重写，之后只维护此分支

## 起因

ui 需要展现一些特定的字体，但直接引入字体包又过大，于是想到了裁剪字体，一开始想的使用「字蛛」但他是针对静态网站的，而且实际他会多出许多英文的，估计是直接将源码中存在的文字都算进去了。
后来又找到阿里的「webfont」 但他的字体有限，项目又不开源，所以自己写了这个

## 在线尝试

- [web font 在线站点](https://webfont.shenzilong.cn/)

## 目的与功能

1.裁剪字体包使其仅包含选中的字体

例如 如下图生成的字体包仅包含 「天地无极乾坤借法」
![界面预览](./doc_img/页面截图.jpg)

<video src="./doc_img/功能演示.mkv" controls="controls" width:100% height:auto></video>

其体积自然十分之小

![体积展示](./doc_img/体积展示.jpg)

2.另外可以生成 css 直接复制可用，部署在公网便可永久访问

例如

```css
@font-face {
    font-family: "QIJIC";
    src: url("http://127.0.0.1:3000/asset/font/1584680576469/令东齐伋复刻体.eot"); /* IE9 */
    src: url("http://127.0.0.1:3000/asset/font/1584680576469/令东齐伋复刻体.eot?#iefix") format("embedded-opentype"), /* IE6-IE8 */
    url("http://127.0.0.1:3000/asset/font/1584680576469/令东齐伋复刻体.woff") format("woff"), /* chrome, firefox */
    url("http://127.0.0.1:3000/asset/font/1584680576469/令东齐伋复刻体.ttf") format("truetype"), /* chrome, firefox, opera, Safari, Android, iOS 4.2+ */
    url("http://127.0.0.1:3000/asset/font/1584680576469/令东齐伋复刻体.svg#QIJIC") format("svg"); /* iOS 4.1- */
    font-style: normal;
    font-weight: normal;
}
```

3.将 ttf 的字体包放置在 ./asset/font_src/ 目录下自然可以检测到新的可用字体，无需重启服务

![路径预览](./doc_img/路径展示.jpg)

4.提供 zip 的整体下载方案

![下载展示](./doc_img/下载展示.jpg)

## 安装与使用

### 使用docker安装

https://hub.docker.com/repository/docker/llej0/web-font
很小的包体积
![alt text](doc/image.png)

docker compoose.yml
```yml
version: 'latest'
services:
  app:
    image: llej0/web-font:latest
    ports:
      - "8087:8087"
    volumes:
      - /home/zixu/code/webfont/font:/home/font
```
其中font目录替换成你的字体文件存放目录


### 使用node等运行时

pnpm install && pnpm build && pnpm build_backend && node ./dist_backend/

## 提供的服务



## 鸣谢

[字体天下](http://www.fonts.net.cn/commercial-free-32767/fonts-zh-1.html)

[fontmin](https://github.com/ecomfe/fontmin)

## License

MIT © [崮生](https://shenzilong.cn/关于/mit.html)
