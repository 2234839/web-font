FROM scratch
WORKDIR /home/
COPY dist_backend/app.lrt /home/app.lrt
COPY llrt2 /home/llrt
COPY dist/ /home/dist/
EXPOSE 80
CMD ["/home/llrt", "/home/app.lrt"]

# docker tag web-font:latest llej0/web-font:latest
# docker push llej0/web-font:latest
# docker build -t llej0/web-font:latest .