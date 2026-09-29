FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /codenames-pictures .

FROM gcr.io/distroless/static-debian12
COPY --from=build /codenames-pictures /codenames-pictures
# Zoom-size pictures (same file names as web/cards), served at /cards-large/.
COPY cards-large /cards-large
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/codenames-pictures", "-large", "/cards-large"]
