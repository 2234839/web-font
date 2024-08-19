# FROM scratch
# WORKDIR /home/
# COPY dist_backend/app.lrt /home/app.lrt
# COPY llrt2 /home/llrt
# COPY dist/ /home/dist/
# EXPOSE 80
# CMD ["/home/llrt", "/home/app.lrt"]


# FROM busybox

FROM busybox
WORKDIR /app/
COPY tjs /app/tjs
RUN chmod +x /app/tjs
COPY dist_backend/app.cjs /app/app.cjs
COPY dist/ /app/dist/
CMD ["./tjs","run","./app.cjs"]

# docker tag llej0/web-font:latest llej0/web-font:latest
# docker push llej0/web-font:latest
# docker build -t llej0/web-font:latest .
# docker save -o llej0.web-font.latest.tar llej0/web-font:latest

# docker inspect llej0/web-font:latest | grep -i "workingdir"