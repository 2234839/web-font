FROM scratch
WORKDIR /home/
COPY dist_backend/app.lrt /home/app.lrt
COPY llrt /home/llrt
COPY dist/ /home/dist/
CMD ["/home/llrt", "/home/app.lrt"]