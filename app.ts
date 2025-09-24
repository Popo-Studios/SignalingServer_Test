import WebSocket, { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';

interface SignalingMessage {
    type: string;
    from: string;
    to?: string;
    data: any;
}

interface ClientInfo {
    id: string;
    ws: WebSocket;
    isAlive: boolean;
}

class P2PSignalingServer {
    private wss: WebSocketServer;
    private clients: Map<string, ClientInfo> = new Map();
    
    constructor(port: number = 8080) {
        this.wss = new WebSocketServer({ 
            port,
            perMessageDeflate: false 
        });
        
        console.log(`시그널링 서버가 포트 ${port}에서 시작되었습니다.`);
        this.setupServer();
        this.startHeartbeat();
    }

    private setupServer(): void {
        this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
            console.log('새로운 클라이언트 연결됨:', request.socket.remoteAddress);
            
            const clientInfo: Partial<ClientInfo> = {
                ws,
                isAlive: true
            };

            // 하트비트 설정
            ws.on('pong', () => {
                if (clientInfo.id) {
                    const client = this.clients.get(clientInfo.id);
                    if (client) {
                        client.isAlive = true;
                    }
                }
            });

            ws.on('message', (data: Buffer) => {
                try {
                    const message: SignalingMessage = JSON.parse(data.toString());
                    this.handleMessage(ws, message, clientInfo as ClientInfo);
                } catch (error) {
                    console.error('메시지 파싱 오류:', error);
                    this.sendError(ws, 'Invalid JSON format');
                }
            });

            ws.on('close', () => {
                if (clientInfo.id) {
                    console.log(`클라이언트 연결 해제: ${clientInfo.id}`);
                    this.clients.delete(clientInfo.id);
                    this.broadcastPeerList();
                }
            });

            ws.on('error', (error) => {
                console.error('WebSocket 오류:', error);
                if (clientInfo.id) {
                    this.clients.delete(clientInfo.id);
                }
            });
        });

        this.wss.on('error', (error) => {
            console.error('서버 오류:', error);
        });
    }

    private handleMessage(ws: WebSocket, message: SignalingMessage, clientInfo: ClientInfo): void {
        console.log(`메시지 수신 [${message.type}]:`, message);

        switch (message.type) {
            case 'register':
                this.handleRegister(ws, message, clientInfo);
                break;
                
            case 'offer':
                this.handleOffer(message);
                break;
                
            case 'answer':
                this.handleAnswer(message);
                break;
                
            case 'ice-candidate':
                this.handleIceCandidate(message);
                break;
                
            case 'udp-info':
                this.handleUdpInfo(message);
                break;
                
            case 'get-peers':
                this.sendPeerList(ws);
                break;
                
            default:
                console.warn('알 수 없는 메시지 타입:', message.type);
                this.sendError(ws, `Unknown message type: ${message.type}`);
        }
    }

    private handleRegister(ws: WebSocket, message: SignalingMessage, clientInfo: ClientInfo): void {
        const clientId = message.data?.id || message.from;
        
        if (!clientId) {
            this.sendError(ws, 'Client ID is required');
            return;
        }

        // 기존 클라이언트가 있다면 연결 해제
        if (this.clients.has(clientId)) {
            const existingClient = this.clients.get(clientId)!;
            existingClient.ws.close();
            console.log(`기존 클라이언트 교체: ${clientId}`);
        }

        // 새 클라이언트 등록
        clientInfo.id = clientId;
        this.clients.set(clientId, clientInfo);
        
        console.log(`클라이언트 등록됨: ${clientId}`);
        
        // 등록 확인 메시지 전송
        this.sendMessage(ws, {
            type: 'registered',
            from: 'server',
            to: clientId,
            data: { 
                success: true, 
                id: clientId,
                timestamp: Date.now()
            }
        });

        // 모든 클라이언트에게 업데이트된 피어 목록 전송
        this.broadcastPeerList();
    }

    private handleOffer(message: SignalingMessage): void {
        const targetClient = this.clients.get(message.to!);
        if (targetClient) {
            console.log(`Offer 전달: ${message.from} -> ${message.to}`);
            this.sendMessage(targetClient.ws, message);
        } else {
            console.warn(`대상 클라이언트를 찾을 수 없음: ${message.to}`);
            const senderClient = this.clients.get(message.from);
            if (senderClient) {
                this.sendError(senderClient.ws, `Peer not found: ${message.to}`);
            }
        }
    }

    private handleAnswer(message: SignalingMessage): void {
        const targetClient = this.clients.get(message.to!);
        if (targetClient) {
            console.log(`Answer 전달: ${message.from} -> ${message.to}`);
            this.sendMessage(targetClient.ws, message);
        } else {
            console.warn(`대상 클라이언트를 찾을 수 없음: ${message.to}`);
        }
    }

    private handleIceCandidate(message: SignalingMessage): void {
        // ICE candidate는 모든 다른 클라이언트에게 브로드캐스트
        // 실제로는 특정 피어에게만 전송해야 하지만, 간단히 브로드캐스트
        this.clients.forEach((client, clientId) => {
            if (clientId !== message.from && client.ws.readyState === WebSocket.OPEN) {
                const forwardedMessage = {
                    ...message,
                    to: clientId
                };
                this.sendMessage(client.ws, forwardedMessage);
            }
        });
        
        console.log(`ICE Candidate 브로드캐스트: ${message.from}`);
    }

    private handleUdpInfo(message: SignalingMessage): void {
        // UDP 정보도 다른 모든 클라이언트에게 브로드캐스트
        this.clients.forEach((client, clientId) => {
            if (clientId !== message.from && client.ws.readyState === WebSocket.OPEN) {
                const forwardedMessage = {
                    ...message,
                    to: clientId
                };
                this.sendMessage(client.ws, forwardedMessage);
            }
        });
        
        console.log(`UDP Info 브로드캐스트: ${message.from} - ${message.data?.endpoint}`);
    }

    private sendPeerList(ws: WebSocket): void {
        const peers = Array.from(this.clients.keys());
        this.sendMessage(ws, {
            type: 'peer-list',
            from: 'server',
            data: { peers }
        });
    }

    private broadcastPeerList(): void {
        const peers = Array.from(this.clients.keys());
        const peerListMessage = {
            type: 'peer-list',
            from: 'server',
            data: { peers }
        };

        console.log('피어 목록 브로드캐스트:', peers);

        this.clients.forEach((client) => {
            if (client.ws.readyState === WebSocket.OPEN) {
                this.sendMessage(client.ws, peerListMessage);
            }
        });
    }

    private sendMessage(ws: WebSocket, message: SignalingMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(message));
            } catch (error) {
                console.error('메시지 전송 오류:', error);
            }
        }
    }

    private sendError(ws: WebSocket, error: string): void {
        this.sendMessage(ws, {
            type: 'error',
            from: 'server',
            data: { error, timestamp: Date.now() }
        });
    }

    private startHeartbeat(): void {
        const interval = setInterval(() => {
            this.clients.forEach((client, clientId) => {
                if (!client.isAlive) {
                    console.log(`하트비트 실패로 클라이언트 제거: ${clientId}`);
                    client.ws.terminate();
                    this.clients.delete(clientId);
                    return;
                }

                client.isAlive = false;
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.ping();
                }
            });

            // 연결이 끊어진 클라이언트가 있으면 피어 목록 업데이트
            this.broadcastPeerList();
        }, 30000); // 30초마다 하트비트

        // 서버 종료 시 정리
        process.on('SIGTERM', () => {
            clearInterval(interval);
            this.shutdown();
        });

        process.on('SIGINT', () => {
            clearInterval(interval);
            this.shutdown();
        });
    }

    private shutdown(): void {
        console.log('서버를 종료합니다...');
        
        this.clients.forEach((client) => {
            client.ws.close();
        });
        
        this.wss.close(() => {
            console.log('서버가 정상적으로 종료되었습니다.');
            process.exit(0);
        });
    }

    // 서버 상태 정보
    public getStatus() {
        return {
            connectedClients: this.clients.size,
            clients: Array.from(this.clients.keys()),
            uptime: process.uptime()
        };
    }
}

// 서버 실행
const server = new P2PSignalingServer(parseInt(process.env.PORT ?? "8080"));

// 상태 체크를 위한 간단한 로깅
setInterval(() => {
    const status = server.getStatus();
    console.log(`[상태] 연결된 클라이언트: ${status.connectedClients}명, 업타임: ${Math.floor(status.uptime as number)}초`);
}, 60000); // 1분마다