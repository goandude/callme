// Filename: /pages/index.tsx
// Description: FINAL-FIXED VERSION. Adds a TURN server to solve ICE negotiation failures, which was the true root cause.

// --- Imports ---
import { useState, useRef, useEffect, FC, KeyboardEvent } from 'react';
import { supabase } from '../lib/supabaseClient';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Phone, Video, VideoOff, Mic, MicOff, Send, SkipForward } from 'lucide-react';

// --- Type Definitions ---
type AppState = 'IDLE' | 'AWAITING_MEDIA' | 'READY' | 'SEARCHING' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
interface OfferPayload { offer: RTCSessionDescriptionInit; }
interface AnswerPayload { answer: RTCSessionDescriptionInit; }
interface CandidatePayload { candidate: RTCIceCandidateInit; }
interface Message { id: string; userId: string; text: string; }

// --- Chat Controller ---
class ChatController {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private queuedCandidates: RTCIceCandidateInit[] = [];
  
  private lobbyChannel: RealtimeChannel | null = null;
  private directMessageChannel: RealtimeChannel | null = null;
  private roomChannel: RealtimeChannel | null = null;

  private pairingTimeout: NodeJS.Timeout | null = null;

  private userId: string;
  private isTransitioning: boolean = false;
  private isOfferCreator: boolean = false;
  
  private onStateChange: (state: AppState) => void;
  private onLocalStream: (stream: MediaStream | null) => void;
  private onRemoteStream: (stream: MediaStream | null) => void;
  private onNewMessage: (message: Message) => void;

  constructor(
    onStateChange: (state: AppState) => void,
    onLocalStream: (stream: MediaStream | null) => void,
    onRemoteStream: (stream: MediaStream | null) => void,
    onNewMessage: (message: Message) => void
  ) {
    this.userId = `user_${Math.random().toString(36).substring(2, 9)}`;
    this.onStateChange = onStateChange;
    this.onLocalStream = onLocalStream;
    this.onRemoteStream = onRemoteStream;
    this.onNewMessage = onNewMessage;
  }

  getUserId = () => this.userId;

  async initialize() {
    this.onStateChange('AWAITING_MEDIA');
    try {
      if (!this.localStream) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        this.localStream = stream;
        this.onLocalStream(stream);
      }
      this.onStateChange('IDLE');
    } catch (err) { this.onStateChange('ERROR'); }
  }
  
  async startChat() {
    if (this.isTransitioning) return;
    this.isTransitioning = true;
    this.onStateChange('SEARCHING');
    await this.cleanup(); 

    const dmChannelName = `dm-${this.userId}`;
    this.directMessageChannel = supabase.channel(dmChannelName);
    this.directMessageChannel
      .on('broadcast', { event: 'pairing_request' }, async ( { payload }: { payload: { roomId: string } } ) => {
        if (this.pc || this.isTransitioning) return;
        this.isTransitioning = true;

        this.isOfferCreator = false;

        await this.cleanupLobby();
        await this.joinRoom(payload.roomId);
        
        await this.roomChannel?.send({ type: 'broadcast', event: 'peer_ready', payload: {} });
        this.isTransitioning = false;
      })
      .subscribe();

    this.lobbyChannel = supabase.channel('lobby', { config: { broadcast: { ack: true } } });
    this.lobbyChannel
      .on('broadcast', { event: 'looking_for_partner' }, async ({ payload }: { payload: { directChannel: string } }) => {
        if (this.pc || this.isTransitioning) return; 
        if (payload.directChannel === dmChannelName) return;

        this.isTransitioning = true;
        this.isOfferCreator = true;
        
        await this.cleanupLobby();
        const newRoomId = `room_${Math.random().toString(36).substring(2, 12)}`;
        
        this.pairingTimeout = setTimeout(() => {
          this.hangUp(true);
        }, 5000);

        await supabase.channel(payload.directChannel).send({
          type: 'broadcast',
          event: 'pairing_request',
          payload: { roomId: newRoomId }
        });

        await this.joinRoom(newRoomId);
        this.isTransitioning = false;
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          this.isTransitioning = false;
          await this.lobbyChannel?.send({ type: 'broadcast', event: 'looking_for_partner', payload: { directChannel: dmChannelName } });
        }
      });
  }

  private async joinRoom(roomId: string) {
    this.onStateChange('CONNECTING');
    this.roomChannel = supabase.channel(`signaling-${roomId}`);
    
    this.roomChannel
      .on('broadcast', { event: 'peer_ready' }, async () => {
        if (this.isOfferCreator) {
          if (this.pairingTimeout) clearTimeout(this.pairingTimeout);
          this.pairingTimeout = null;
          await this.createOffer();
        }
      })
      .on('broadcast', { event: 'offer' }, async ({ payload }: { payload: OfferPayload }) => {
        if (!this.pc) this.createPeerConnection();
        await this.pc!.setRemoteDescription(new RTCSessionDescription(payload.offer));
        this.processQueuedCandidates();
        const answer = await this.pc!.createAnswer();
        await this.pc!.setLocalDescription(answer);
        await this.roomChannel?.send({ type: 'broadcast', event: 'answer', payload: { answer } });
      })
      .on('broadcast', { event: 'answer' }, async ({ payload }: { payload: AnswerPayload }) => {
        if (this.pc?.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(new RTCSessionDescription(payload.answer));
          this.processQueuedCandidates();
        }
      })
      .on('broadcast', { event: 'candidate' }, async ({ payload }: { payload: CandidatePayload }) => {
        if (this.pc?.remoteDescription) {
          await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } else {
          this.queuedCandidates.push(payload.candidate);
        }
      })
      .subscribe();
  }

  private createPeerConnection() {
    if (this.pc) return;
    
    // *** THE DEFINITIVE FIX IS HERE ***
    // We are adding a TURN server to the configuration. This allows the connection
    // to be relayed through a server when a direct peer-to-peer path cannot be
    // established due to restrictive firewalls or NATs.
    this.pc = new RTCPeerConnection({ 
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { 
              urls: 'turn:relay.metered.ca:80',
              username: '83e21626570551a6152b3433',
              credential: 'aDN0a7Hj6sUe3R3a'
            }
        ] 
    });
    
    this.dataChannel = this.pc.createDataChannel('chat');
    this.dataChannel.onmessage = (e) => this.onNewMessage(JSON.parse(e.data));
    this.pc.ondatachannel = (e) => {
      this.dataChannel = e.channel;
      this.dataChannel.onmessage = (ev) => this.onNewMessage(JSON.parse(ev.data));
    };
    this.localStream?.getTracks().forEach(track => this.pc!.addTrack(track, this.localStream!));
    this.pc.ontrack = (e) => this.onRemoteStream(e.streams[0]);
    this.pc.onicecandidate = async (e) => {
      if (e.candidate) {
        await this.roomChannel?.send({ type: 'broadcast', event: 'candidate', payload: { candidate: e.candidate } });
      }
    };
    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (state === 'connected') {
        this.onStateChange('CONNECTED');
      } else if (state === 'disconnected' || state === 'failed') {
        this.hangUp(true); 
      }
    };
  }

  private async createOffer() {
    if (!this.pc) this.createPeerConnection();
    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    await this.roomChannel?.send({ type: 'broadcast', event: 'offer', payload: { offer } });
  }

  private async cleanup() {
    this.pc?.close();
    this.pc = null;
    if (this.pairingTimeout) clearTimeout(this.pairingTimeout);
    this.pairingTimeout = null;
    await this.cleanupLobby();
    if(this.directMessageChannel) await supabase.removeChannel(this.directMessageChannel);
    if(this.roomChannel) await supabase.removeChannel(this.roomChannel);
    this.directMessageChannel = null;
    this.roomChannel = null;
    this.queuedCandidates = [];
    this.isOfferCreator = false;
  }

  private async cleanupLobby() {
    if(this.lobbyChannel) await supabase.removeChannel(this.lobbyChannel);
    this.lobbyChannel = null;
  }

  async hangUp(reconnect: boolean = false) {
    if (this.isTransitioning && !reconnect) return;
    this.isTransitioning = true;
    this.onRemoteStream(null);
    if (this.pc?.connectionState !== 'connected' && reconnect) {
        this.onStateChange('SEARCHING');
    } else if (!reconnect) {
        this.onStateChange('IDLE');
    }
    await this.cleanup();
    if (reconnect) {
      setTimeout(() => {
        this.isTransitioning = false;
        this.startChat();
      }, 250);
    } else {
      this.isTransitioning = false;
    }
  }

  sendMessage = (text: string): Message | null => {
    if (text.trim() && this.dataChannel?.readyState === 'open') {
      const message: Message = { id: `msg_${Math.random()}`, userId: this.userId, text };
      this.dataChannel.send(JSON.stringify(message));
      return message;
    }
    return null;
  };

  toggleMute = () => this.localStream?.getAudioTracks().forEach(t => t.enabled = !t.enabled);
  toggleVideo = () => this.localStream?.getVideoTracks().forEach(t => t.enabled = !t.enabled);
  processQueuedCandidates = () => {
    while (this.queuedCandidates.length > 0 && this.pc?.remoteDescription) {
      const cand = this.queuedCandidates.shift();
      if (cand) this.pc!.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.error('ICE error:', e));
    }
  };
}

// --- Main React Component ---
const Home: FC = () => {
    const [userId, setUserId] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const [chatInput, setChatInput] = useState('');
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
    const [appState, setAppState] = useState<AppState>('IDLE');
    
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const controllerRef = useRef<ChatController | null>(null);

    useEffect(() => {
        if (controllerRef.current === null) {
            const chatController = new ChatController(
                (state) => setAppState(state),
                (stream) => setLocalStream(stream),
                (stream) => setRemoteStream(stream),
                (message) => setMessages(prev => [...prev, message])
            );
            controllerRef.current = chatController;
            setUserId(chatController.getUserId());
            chatController.initialize(); 
        }
        const controller = controllerRef.current;
        const handleBeforeUnload = () => controller?.hangUp(false);
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            controller?.hangUp(false);
        }
    }, []);

    useEffect(() => { if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream; }, [localStream]);
    useEffect(() => { if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream; }, [remoteStream]);
    
    const handleSendMessage = () => {
        const sentMessage = controllerRef.current?.sendMessage(chatInput.trim());
        if (sentMessage) {
            setMessages(prev => [...prev, sentMessage]);
            setChatInput('');
        }
    }
    const handleToggleMute = () => { controllerRef.current?.toggleMute(); setIsMuted(!isMuted); }
    const handleToggleVideo = () => { controllerRef.current?.toggleVideo(); setIsVideoOff(!isVideoOff); }

    const getStatusText = (): string => {
        switch (appState) {
            case 'IDLE': return 'Ready';
            case 'AWAITING_MEDIA': return 'Getting camera...';
            case 'SEARCHING': return 'Searching for a partner...';
            case 'CONNECTING': return 'Connecting...';
            case 'CONNECTED': return 'Connected';
            case 'ERROR': return 'Connection lost...';
            default: return 'Offline';
        }
    };

    return (
        <div className="h-screen w-screen bg-[#F7F7F7] text-[#1D1D1F] flex font-sans overflow-hidden">
            <aside className="hidden md:flex w-[72px] bg-white border-r border-gray-200 flex-shrink-0 flex-col items-center py-6 space-y-6">
                <div className="w-10 h-10 rounded-lg bg-blue-500 text-white flex items-center justify-center font-bold text-lg">C</div>
            </aside>
            <div className="flex-1 flex flex-col">
                <header className="h-[60px] md:h-[72px] border-b border-gray-200 flex-shrink-0 flex items-center px-4 md:px-6 justify-between">
                    <h1 className="text-lg md:text-xl font-semibold">Video Chat</h1>
                </header>
                <div className="flex-1 flex flex-col md:flex-row min-h-0">
                    <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2 p-2 md:gap-6 md:p-6">
                        <div className="bg-gray-200 rounded-xl overflow-hidden shadow-md flex flex-col min-h-[50vh] md:min-h-0">
                            <div className="flex-1 relative bg-black">
                               <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                               <div className="absolute top-2 left-2 md:top-4 md:left-4 bg-black/50 text-white px-2 py-1 rounded-md text-xs md:text-sm font-semibold">You</div>
                                {isVideoOff && localStream && <div className="absolute inset-0 bg-black/70 flex items-center justify-center"><p className="text-white">Video Off</p></div>}
                            </div>
                        </div>
                        <div className="bg-gray-200 rounded-xl overflow-hidden shadow-md flex flex-col min-h-[50vh] md:min-h-0">
                            <div className="flex-1 relative bg-black">
                               <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
                               <div className="absolute top-2 left-2 md:top-4 md:left-4 bg-black/50 text-white px-2 py-1 rounded-md text-xs md:text-sm font-semibold">Stranger</div>
                               {appState !== 'CONNECTED' && (
                                   <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-100 text-gray-800 p-4 text-center">
                                       <h2 className="text-xl md:text-2xl font-semibold">{getStatusText()}</h2>
                                       {appState === 'IDLE' && (
                                           <button onClick={() => controllerRef.current?.startChat()} className="mt-4 bg-blue-500 text-white font-semibold rounded-lg px-6 py-2 transition-transform hover:scale-105">
                                               Find Partner
                                           </button>
                                       )}
                                   </div>
                               )}
                            </div>
                        </div>
                    </div>
                    <div className="w-full md:w-80 border-t md:border-t-0 md:border-l border-gray-200 flex flex-col">
                        <div className="h-[60px] flex-shrink-0 border-b border-gray-200 px-4 flex items-center">
                            <h2 className="font-semibold">Chat</h2>
                        </div>
                        <div className="flex-1 p-4 overflow-y-auto space-y-4">
                            {messages.map(msg => (
                                <div key={msg.id} className={`flex ${msg.userId === userId ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`p-2 px-3 rounded-lg max-w-xs break-words ${msg.userId === userId ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'}`}>
                                        <p className="text-xs font-semibold mb-1">{msg.userId === userId ? 'You' : `Stranger`}</p>
                                        <p className="text-sm">{msg.text}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                         <div className="flex-shrink-0 border-t border-gray-200 p-2 flex flex-col space-y-2">
                             <div className="relative">
                                <input type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && handleSendMessage()}
                                    placeholder="Type a message..." className="w-full h-10 md:h-12 bg-gray-100 rounded-lg pl-4 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" disabled={appState !== 'CONNECTED'}/>
                                <button onClick={handleSendMessage} disabled={appState !== 'CONNECTED' || !chatInput.trim()} className="absolute right-1 top-1/2 -translate-y-1/2 p-2 rounded-full text-gray-500 hover:bg-gray-200 disabled:text-gray-300"><Send size={18}/></button>
                            </div>
                             <div className="flex-shrink-0 flex items-center justify-center space-x-2">
                                <button onClick={handleToggleMute} disabled={appState !== 'CONNECTED'} className={`p-2 md:p-3 rounded-lg ${isMuted ? 'bg-gray-300' : 'bg-gray-200 hover:bg-gray-300'} disabled:bg-gray-100 disabled:text-gray-400`}>{isMuted ? <MicOff size={20} /> : <Mic size={20} />}</button>
                                <button onClick={handleToggleVideo} disabled={appState !== 'CONNECTED'} className={`p-2 md:p-3 rounded-lg ${isVideoOff ? 'bg-gray-300' : 'bg-gray-200 hover:bg-gray-300'} disabled:bg-gray-100 disabled:text-gray-400`}>{isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}</button>
                                <button onClick={() => controllerRef.current?.hangUp(true)} disabled={appState !== 'CONNECTED'} className="px-3 py-2 md:px-4 md:py-3 text-sm rounded-lg bg-gray-500 text-white font-semibold disabled:bg-gray-300 flex items-center space-x-2">
                                    <SkipForward size={20} />
                                    <span className="hidden md:inline">Skip</span>
                                </button>
                                <button onClick={() => controllerRef.current?.hangUp(false)} disabled={appState === 'IDLE'} className="px-3 py-2 md:px-4 md:py-3 text-sm rounded-lg bg-red-500 text-white font-semibold disabled:bg-red-300 flex items-center space-x-2">
                                    <Phone size={20} />
                                    <span className="hidden md:inline">End</span>
                                </button>
                            </div>
                         </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default Home;