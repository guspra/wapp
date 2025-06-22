# wapp - WhatsApp Message Sender

A simple, self-hosted web application to send and schedule WhatsApp messages from your personal number using the Baileys API, Node.js, and Docker.

## Features

- **Send Messages**: Send WhatsApp messages to any number directly from a web interface.
- **QR Code Login**: A web-based UI for linking your WhatsApp account by scanning a QR code.
- **Session Persistence**: Your WhatsApp session is saved, so you don't need to log in every time the app restarts.
- **Message Scheduling**: Schedule messages to be sent at a future date and time in specific timezones.
- **Scheduled Message Management**: View a list of all pending scheduled messages and cancel them individually.
- **Dockerized**: Easy to set up and deploy anywhere using Docker.

## Prerequisites

- [Node.js](https://nodejs.org/) (v20.x or later for local development)
- [Docker](https://www.docker.com/products/docker-desktop/)

---

## Local Setup (For Development)

Follow these steps to run the application on your local machine for development and testing.

1.  **Clone the Repository**

    ```bash
    git clone <your-repository-url>
    cd wapp
    ```

2.  **Install Dependencies**
    This will install all the necessary libraries and generate a `package-lock.json` file.

    ```bash
    npm install
    ```

3.  **Run the Application**
    This will start the server directly on your machine.

    ```bash
    npm start
    ```

4.  **Access the App**
    Open your web browser and navigate to `http://localhost:3000/wapp`.

---

## Docker Setup (Recommended)

Using Docker is the recommended way to run this application both locally and in production.

### Running Locally with Docker

1.  **Build the Docker Image**
    From the project's root directory, run:

    ```bash
    docker build -t wapp .
    ```

2.  **Run the Docker Container**
    This command will start the application and persist your WhatsApp session data in a Docker volume.

    ```bash
    docker run --name wapp --restart unless-stopped -p 3000:3000 -v baileys_auth_data:/app/baileys_auth_info -d wapp
    ```

3.  **Access the App**
    Open your web browser and navigate to `http://localhost:3000/wapp`.

### Deploying to an EC2 Instance

1.  **Launch an EC2 Instance**

    - Go to the AWS EC2 console and launch a new instance.
    - **AMI**: **Amazon Linux 2023** or **Ubuntu Server 22.04 LTS** are recommended.
    - **Instance Type**: `t2.micro` or `t3.micro` is sufficient.
    - **Security Group**: This is crucial. Create a new security group and add the following **inbound rules**:
      - **Type**: `SSH`, **Port**: `22`, **Source**: `My IP` (for secure access).
      - **Type**: `Custom TCP`, **Port**: `3000`, **Source**: `Anywhere-IPv4` (0.0.0.0/0) to allow web access to your app.

2.  **Connect to Your EC2 Instance**
    Use SSH with the `.pem` key you downloaded when creating the instance.

    ```bash
    # Replace with your key and IP address
    ssh -i "your-key.pem" ec2-user@your-public-ip
    ```

3.  **Install Prerequisites on EC2**
    Install Git and Docker on the instance.

    ```bash
    # Update packages and install git & docker
    sudo dnf update -y
    sudo dnf install git docker -y

    # Start and enable Docker service
    sudo systemctl start docker
    sudo systemctl enable docker

    # Add your user to the docker group to run docker commands without sudo
    sudo usermod -aG docker ec2-user
    newgrp docker # Apply new group membership immediately
    ```

4.  **Deploy the Application**

    - Clone your repository onto the EC2 instance.
      ```bash
      git clone <your-repository-url>
      cd wapp
      ```
    - Build the Docker image.
      ```bash
      docker build -t wapp .
      ```
    - Run the Docker container.
      ```bash
      docker run --name wapp --restart unless-stopped -p 3000:3000 -v baileys_auth_data:/app/baileys_auth_info -d wapp
      ```

5.  **Access Your Deployed App**
    - Check the logs to get the QR code for the initial login.
      ```bash
      docker logs -f wapp
      ```
    - Open your web browser and navigate to `http://<your-ec2-ip>:3000/wapp`.
