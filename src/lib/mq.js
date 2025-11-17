import amqplib from 'amqplib';

class MQClient {
  constructor(url) {
    this.url = url;
    this.conn = null;
    this.channel = null;
    this.exchange = 'app.events';
  }
  async connect() {
    if (this.channel) return this.channel;
    this.conn = await amqplib.connect(this.url);
    this.channel = await this.conn.createChannel();
    await this.channel.assertExchange(this.exchange, 'topic', { durable: true });
    console.log('[MQ] Order-service connected to RabbitMQ');
    return this.channel;
  }
  async publish(routingKey, message) {
    await this.connect();
    const payload = Buffer.from(JSON.stringify(message));
    this.channel.publish(this.exchange, routingKey, payload, { persistent: true });
  }
  async close() {
    await this.channel?.close();
    await this.conn?.close();
  }
}

export const mqClient = new MQClient(process.env.RABBITMQ_URL);