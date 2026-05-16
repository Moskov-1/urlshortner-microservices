FROM golang:1.24-alpine

# Install build dependencies
RUN apk add --no-cache gcc musl-dev sqlite-dev sqlite-static

WORKDIR /app

# IMPORTANT: Do not comment out go.sum
COPY go.mod go.sum ./
RUN go mod download

# Copy EVERYTHING so the compiler sees all files
COPY . .

# Set environment variables for the build
ENV CGO_ENABLED=1
ENV GOOS=linux

# Build with static linking flags for Alpine compatibility
RUN go build -tags libsqlite3 -ldflags "-linkmode external -extldflags=-static" -o urlshortener main.go

EXPOSE 8000

CMD ["./urlshortener"]