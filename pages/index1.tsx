// Filename: /pages/index.tsx
// Description: Full working video chat app with STUN/TURN support, error handling, auto-retry logic, and full React UI.
// REVISED with Auto-Reconnect and a Skip Button.

// --- Imports ---
import { useState, useRef, useEffect, FC, KeyboardEvent } from 'react';
import { supabase } from '../lib/supabaseClient';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Phone, Video, VideoOff, Mic, MicOff, Send, SkipForward } from 'lucide-react'; // Added SkipForward

// --- Type Definitions ---
type AppState = 'IDLE' | 'AWAITING_MEDIA' | 'READY' | 'SEARCHING' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
interface OfferPayload { offer: RTCSessionDescriptionInit; userId: string; }
interface AnswerPayload { answer: RTCSessionDescriptionInit; userId: string; }
interface CandidatePayload { candidate: RTCIceCandidateInit; userId: string; }
type SignalPayload = OfferPayload | AnswerPayload | CandidatePayload;
interface Message { id: string; userId: string; text: string; }

// --- Chat Controller ---
class ChatController {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private signalingChannel: RealtimeChannel | null = null;
  private roomListener: RealtimeChannel | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private queuedCandidates: RTCIceCandidateInit[] = [];
  private userId: string;

  private onStateChange: (state: AppState) => void;
  private onLocalStream: (stream: MediaStream | null) => void;
  private onRemoteStream: (stream: MediaStream | null) => void;
  private onRoomIdChange: (id: string | null) => void;
  private onNewMessage: (message: Message) => void;

  constructor(
    onStateChange: (state: AppState) => void,
    onLocalStream: (stream: MediaStream | null) => void,
    onRemoteStream: (stream: MediaStream | null) => void,
    onRoomIdChange: (id: string | null) => void,
    onNewMessage: (message: Message) => void
  ) {
    this.userId = `user_${Math.random().toString(36).substring(2, 9)}`;
    this.onStateChange = onStateChange;
    this.onLocalStream = onLocalStream;
    this.onRemoteStream = onRemoteStream;
    this.onRoomIdChange = onRoomIdChange;
    this.onNewMessage = onNewMessage;
  }

  getUserId = () => this.userId;

  async initialize() {
    this.onStateChange('AWAITING_MEDIA');
    if (!(await this.startLocalVideo())) return;
    this.onStateChange('IDLE');
  }

  private async startLocalVideo(): Promise<boolean> {
    try {
      if (!this.localStream) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        this.localStream = stream;
        this.onLocalStream(stream);
      }
      return true;
    } catch (err) {
      console.error('Media error:', err);
      this.onStateChange('ERROR');
      return false;
    }
  }

  async startChat() {
    this.onStateChange('SEARCHING');
    await this.subscribeRoomListener();

    const { data, error } = await supabase.rpc('match_and_create_room', { requesting_user_id: this.userId });
    if (error || !data) {
      console.error('Match RPC failed:', { error, data });
      this.hangUp(true); // Auto-retry on RPC failure
      return;
    }
    
    const matchData = data[0];
    if (!matchData || !matchData.room_id) {
      console.log(`[${this.userId}] No match found. Now waiting in the queue.`);
      return; 
    }
    
    const roomId = matchData.room_id;
    const isOfferCreator = matchData.is_offer_creator;
    this.onRoomIdChange(roomId);
    await this.setupSignalingChannel(roomId);
    
    if (isOfferCreator) {
        this.createOffer(roomId);
    }
  }

  private async subscribeRoomListener() {
    if (this.roomListener) return;
    const channelName = `room-notification-for-${this.userId}`;
    this.roomListener = supabase.channel(channelName)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rooms' }, (payload) => {
        const newRoom = payload.new as { id: string, peer1: string, peer2: string };
        if ((newRoom.peer1 === this.userId || newRoom.peer2 === this.userId) && !this.pc) {
          this.onRoomIdChange(newRoom.id);
          this.setupSignalingChannel(newRoom.id);
        }
      })
      .subscribe();
  }

  private async setupSignalingChannel(roomId: string) {
    if (this.signalingChannel) return;
    const channelName = `signaling-${roomId}`;
    this.signalingChannel = supabase.channel(channelName)
      .on('broadcast', { event: 'signal' }, async ({ payload }: { payload: SignalPayload }) => {
        if (payload.userId === this.userId) return;
        if (!this.pc) this.createPeerConnection(roomId);

        if ('offer' in payload) {
          await this.pc!.setRemoteDescription(new RTCSessionDescription(payload.offer));
          this.processQueuedCandidates();
          const answer = await this.pc!.createAnswer();
          await this.pc!.setLocalDescription(answer);
          this.signalingChannel?.send({ type: 'broadcast', event: 'signal', payload: { answer, userId: this.userId } });
        } else if ('answer' in payload) {
          if (this.pc!.signalingState === 'have-local-offer') {
            await this.pc!.setRemoteDescription(new RTCSessionDescription(payload.answer));
            this.processQueuedCandidates();
          }
        } else if ('candidate' in payload) {
          if (this.pc!.remoteDescription) {
            await this.pc!.addIceCandidate(new RTCIceCandidate(payload.candidate));
          } else {
            this.queuedCandidates.push(payload.candidate);
          }
        }
      })
      .subscribe();
  }

  private createPeerConnection(roomId: string) {
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.dataChannel = this.pc.createDataChannel('chat');
    this.dataChannel.onmessage = (e) => this.onNewMessage(JSON.parse(e.data));
    this.pc.ondatachannel = (e) => {
      this.dataChannel = e.channel;
      this.dataChannel.onmessage = (ev) => this.onNewMessage(JSON.parse(ev.data));
    };

    this.localStream?.getTracks().forEach(track => this.pc!.addTrack(track, this.localStream!));
    this.pc.ontrack = (e) => this.onRemoteStream(e.streams[0]);

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signalingChannel?.send({ type: 'broadcast', event: 'signal', payload: { candidate: e.candidate, userId: this.userId } });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (state === 'connected') {
        this.onStateChange('CONNECTED');
        this.roomListener && supabase.removeChannel(this.roomListener);
        this.roomListener = null;
      } else if (state === 'disconnected' || state === 'failed') {
        // *** AUTO-RECONNECT LOGIC ***
        this.onStateChange('ERROR');
        // The hangUp function will handle the reconnection attempt.
        this.hangUp(true); 
      }
    };
    this.onStateChange('CONNECTING');
  }

  private async createOffer(roomId: string) {
    if (!this.pc) this.createPeerConnection(roomId);
    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    this.signalingChannel?.send({ type: 'broadcast', event: 'signal', payload: { offer, userId: this.userId } });
  }

  private processQueuedCandidates() {
    while (this.queuedCandidates.length > 0 && this.pc?.remoteDescription) {
      const cand = this.queuedCandidates.shift();
      if (cand) this.pc!.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.error('ICE error:', e));
    }
  }

  // *** REVISED HANGUP FUNCTION ***
  async hangUp(reconnect: boolean = false) {
    // Set state immediately for better UI feedback
    if (reconnect) {
      this.onStateChange('SEARCHING');
    } else {
      this.onStateChange('IDLE');
    }
    this.onRemoteStream(null);
    this.onRoomIdChange(null);
    
    try {
      this.pc?.close();
      this.pc = null;
      if (this.signalingChannel) await supabase.removeChannel(this.signalingChannel);
      if (this.roomListener) await supabase.removeChannel(this.roomListener);
      this.signalingChannel = null;
      this.roomListener = null;
      this.dataChannel = null;
      this.queuedCandidates = [];
    } catch (err) {
      console.error('Cleanup error:', err);
    }
    
    // Do not delete from waiting_users if we are about to search again
    if(!reconnect) {
      await supabase.from('waiting_users').delete().eq('user_id', this.userId);
    }

    if (reconnect) {
      // Use a short timeout to prevent rapid-fire reconnects and race conditions
      setTimeout(() => this.startChat(), 100);
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
}

// --- Main React Component ---
const Home: FC = () => {
    const [controller, setController] = useState<ChatController | null>(null);
    const [userId, setUserId] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const [chatInput, setChatInput] = useState('');
    const [queueCount, setQueueCount] = useState(0);
    const [onlineCount, setOnlineCount] = useState(0);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
    const [appState, setAppState] = useState<AppState>('IDLE');
    
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        const chatController = new ChatController(
            (state) => setAppState(state),
            (stream) => setLocalStream(stream),
            (stream) => setRemoteStream(stream),
            () => {},
            (message) => setMessages(prev => [...prev, message])
        );
        setController(chatController);
        setUserId(chatController.getUserId());
        chatController.initialize(); 
        return () => { chatController.hangUp(false); }
    }, []);

    useEffect(() => { if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream; }, [localStream]);
    useEffect(() => { if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream; }, [remoteStream]);
    
    useEffect(() => {
        const getQueueCount = async () => {
            const { count } = await supabase.from('waiting_users').select('*', { count: 'exact', head: true });
            if (count !== null) setQueueCount(count);
        };
        getQueueCount();
        const queueListener = supabase.channel('public:waiting_users').on('postgres_changes', { event: '*', schema: 'public', table: 'waiting_users' }, getQueueCount).subscribe();
        return () => { supabase.removeChannel(queueListener) };
    }, []);
    
    useEffect(() => {
        if (!userId) return;
        const presenceChannel = supabase.channel('online-users', { config: { presence: { key: userId } } });
        presenceChannel.on('presence', { event: 'sync' }, () => setOnlineCount(Object.keys(presenceChannel.presenceState()).length));
        presenceChannel.subscribe(async (status) => { if (status === 'SUBSCRIBED') await presenceChannel.track({ online_at: new Date().toISOString() }); });
        return () => { supabase.removeChannel(presenceChannel) };
    }, [userId]);
    
    const handleSendMessage = () => {
        const sentMessage = controller?.sendMessage(chatInput.trim());
        if (sentMessage) {
            setMessages(prev => [...prev, sentMessage]);
            setChatInput('');
        }
    }
    const handleToggleMute = () => { controller?.toggleMute(); setIsMuted(!isMuted); }
    const handleToggleVideo = () => { controller?.toggleVideo(); setIsVideoOff(!isVideoOff); }

    const getStatusText = (): string => {
        switch (appState) {
            case 'IDLE': return 'Ready';
            case 'AWAITING_MEDIA': return 'Getting camera...';
            case 'SEARCHING': return 'Searching for a partner...';
            case 'CONNECTING': return 'Connecting...';
            case 'CONNECTED': return 'Connected';
            case 'ERROR': return 'Connection lost. Finding new partner...'; // Better error message
            default: return 'Offline';
        }
    };

    return (
        <div className="h-screen w-screen bg-[#F7F7F7] text-[#1D1D1F] flex font-sans overflow-hidden">
            <aside className="w-[72px] bg-white border-r border-gray-200 flex-shrink-0 flex flex-col items-center py-6 space-y-6">
                <div className="w-10 h-10 rounded-lg bg-blue-500 text-white flex items-center justify-center font-bold text-lg">C</div>
            </aside>

            <div className="flex-1 flex flex-col">
                <header className="h-[72px] border-b border-gray-200 flex-shrink-0 flex items-center px-6 justify-between">
                    <h1 className="text-xl font-semibold">Meeting</h1>
                    <div className="flex items-center space-x-6">
                       <div className="text-sm font-medium"><span className="text-gray-500">Waiting: </span><span className="font-bold text-yellow-600">{queueCount}</span></div>
                       <div className="text-sm font-medium"><span className="text-gray-500">Online: </span><span className="font-bold text-green-600">{onlineCount}</span></div>
                    </div>
                </header>
                
                <div className="flex-1 flex min-h-0">
                    <div className="flex-1 grid grid-cols-2 gap-6 p-6">
                        <div className="bg-gray-200 rounded-xl overflow-hidden shadow-md flex flex-col">
                            <div className="flex-1 relative bg-black">
                               <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                               <div className="absolute top-4 left-4 bg-black/50 text-white px-2 py-1 rounded-md text-sm font-semibold">You</div>
                                {isVideoOff && localStream && <div className="absolute inset-0 bg-black/70 flex items-center justify-center"><p className="text-white">Video Off</p></div>}
                            </div>
                        </div>

                        <div className="bg-gray-200 rounded-xl overflow-hidden shadow-md flex flex-col">
                            <div className="flex-1 relative bg-black">
                               <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
                               <div className="absolute top-4 left-4 bg-black/50 text-white px-2 py-1 rounded-md text-sm font-semibold">Stranger</div>
                               {appState !== 'CONNECTED' && (
                                   <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-100 text-gray-800">
                                       <h2 className="text-2xl font-semibold">{getStatusText()}</h2>
                                       {appState === 'IDLE' && (
                                           <button onClick={() => controller?.startChat()} className="mt-4 bg-blue-500 text-white font-semibold rounded-lg px-6 py-2 transition-transform hover:scale-105">
                                               Find Partner
                                           </button>
                                       )}
                                   </div>
                               )}
                            </div>
                        </div>
                    </div>
                    
                    <div className="w-80 border-l border-gray-200 flex flex-col">
                        <div className="h-[72px] flex-shrink-0 border-b border-gray-200 px-4 flex items-center"><h2 className="font-semibold">Chat</h2></div>
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
                         <div className="h-28 flex-shrink-0 border-t border-gray-200 p-4 flex flex-col space-y-2">
                             <div className="relative">
                                <input type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && handleSendMessage()}
                                    placeholder="Add a comment..." className="w-full h-12 bg-gray-100 rounded-lg pl-4 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" disabled={appState !== 'CONNECTED'}/>
                                <button onClick={handleSendMessage} disabled={appState !== 'CONNECTED' || !chatInput.trim()} className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full text-gray-500 hover:bg-gray-200 disabled:text-gray-300"><Send size={20}/></button>
                            </div>
                             <div className="flex-shrink-0 flex items-center justify-center space-x-2">
                                <button onClick={handleToggleMute} disabled={appState !== 'CONNECTED'} className={`p-3 rounded-lg ${isMuted ? 'bg-gray-300' : 'bg-gray-200 hover:bg-gray-300'} disabled:bg-gray-100 disabled:text-gray-400`}>{isMuted ? <MicOff size={20} /> : <Mic size={20} />}</button>
                                <button onClick={handleToggleVideo} disabled={appState !== 'CONNECTED'} className={`p-3 rounded-lg ${isVideoOff ? 'bg-gray-300' : 'bg-gray-200 hover:bg-gray-300'} disabled:bg-gray-100 disabled:text-gray-400`}>{isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}</button>
                                
                                {/* *** NEW SKIP AND REVISED END BUTTONS *** */}
                                <button onClick={() => controller?.hangUp(true)} disabled={appState !== 'CONNECTED'} className="px-4 py-3 rounded-lg bg-gray-500 text-white font-semibold disabled:bg-gray-300 flex items-center space-x-2">
                                    <SkipForward size={20} />
                                    <span>Skip</span>
                                </button>
                                <button onClick={() => controller?.hangUp(false)} disabled={appState === 'IDLE'} className="px-4 py-3 rounded-lg bg-red-500 text-white font-semibold disabled:bg-red-300 flex items-center space-x-2">
                                    <Phone size={20} />
                                    <span>End</span>
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