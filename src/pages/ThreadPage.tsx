import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Heart, ImagePlus, LogIn, LogOut, MessageCircle, Pencil, RefreshCw, Send, Trash2, UserRound, X } from 'lucide-react';
import {
  beginThreadLogin,
  createThreadPost,
  deleteThreadPost,
  getThreadProfile,
  getThreadUser,
  hasThreadSession,
  listThreadPosts,
  listThreadProfilePosts,
  listThreadReplies,
  logoutThread,
  threadAssetUrl,
  toggleThreadLike,
  updateThreadPost,
  uploadThreadImage,
  type ThreadImage,
  type ThreadPost,
  type ThreadProfile,
  type ThreadUser,
} from '../thread/threadApi';
import { THREAD_WEB_URL } from '../config/endpoints';
import './ThreadPage.css';

type ComposerTarget = { mode: 'create' } | { mode: 'reply'; post: ThreadPost } | { mode: 'edit'; post: ThreadPost };

const MAX_BODY = 1_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function ThreadPostCard({ post, userId, onReply, onEdit, onProfile, onSignIn, onDeleted }: {
  post: ThreadPost;
  userId?: number;
  onReply: (post: ThreadPost) => void;
  onEdit: (post: ThreadPost) => void;
  onProfile: (handle: string) => void;
  onSignIn: () => void;
  onDeleted: (postId: number) => void;
}) {
  const [replies, setReplies] = useState<ThreadPost[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [likeBusy, setLikeBusy] = useState(false);
  const [liked, setLiked] = useState(post.likedByViewer);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  useEffect(() => { setLiked(post.likedByViewer); setLikeCount(post.likeCount); }, [post.likedByViewer, post.likeCount]);
  const loadReplies = async () => {
    if (replies) { setReplies(null); return; }
    setLoading(true);
    try { setReplies(await listThreadReplies(post.id)); }
    finally { setLoading(false); }
  };

  const like = async () => {
    if (!userId) { onSignIn(); return; }
    setLikeBusy(true);
    try {
      const result = await toggleThreadLike(post.id);
      setLiked(result.liked);
      setLikeCount(result.likeCount);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not update the like.');
    } finally { setLikeBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm(post.parentId ? 'Delete this reply?' : 'Delete this post and its replies?')) return;
    try {
      await deleteThreadPost(post.id);
      onDeleted(post.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not delete the post.');
    }
  };

  return (
    <article className={`thread-post${post.parentId ? ' reply' : ''}`}>
      <header className="thread-post-head">
        <button type="button" className="thread-author-avatar" title={`View @${post.author.handle}`} onClick={() => onProfile(post.author.handle)}>
          {post.author.avatarUrl ? <img src={post.author.avatarUrl} alt="" /> : <span>{post.author.name.slice(0, 1).toUpperCase()}</span>}
        </button>
        <button type="button" className="thread-author-name" onClick={() => onProfile(post.author.handle)}>
          <strong>{post.author.name}</strong>
          <small>@{post.author.handle} · {formatTime(post.createdAt)}{post.edited ? ' · edited' : ''}</small>
        </button>
        {userId === post.author.id && <div className="thread-owner-actions"><button type="button" title="Edit post" onClick={() => onEdit(post)}><Pencil size={14} /></button><button type="button" title="Delete post" onClick={() => void remove()}><Trash2 size={14} /></button></div>}
      </header>
      {post.body && <p className="thread-post-body">{post.body}</p>}
      {post.images.length > 0 && (
        <div className={`thread-post-images count-${post.images.length}`}>
          {post.images.map((image) => <a key={image.id} href={threadAssetUrl(image.url)} target="_blank" rel="noreferrer"><img src={threadAssetUrl(image.url)} alt="Post attachment" /></a>)}
        </div>
      )}
      <footer className="thread-post-actions">
        <button type="button" onClick={() => onReply(post)}><MessageCircle size={14} /> Reply</button>
        <button type="button" className={liked ? 'liked' : ''} disabled={likeBusy} onClick={() => void like()}><Heart size={14} fill={liked ? 'currentColor' : 'none'} /> {likeCount || 'Like'}</button>
        {!post.parentId && post.replyCount > 0 && (
          <button type="button" disabled={loading} onClick={() => void loadReplies()}>
            {loading ? <RefreshCw size={14} className="spin" /> : <MessageCircle size={14} />}
            {replies ? 'Hide replies' : `${post.replyCount} ${post.replyCount === 1 ? 'reply' : 'replies'}`}
          </button>
        )}
      </footer>
      {replies && replies.length > 0 && <div className="thread-replies">{replies.map((reply) => <ThreadPostCard key={reply.id} post={reply} userId={userId} onReply={onReply} onEdit={onEdit} onProfile={onProfile} onSignIn={onSignIn} onDeleted={(id) => setReplies((items) => items?.filter((item) => item.id !== id) || [])} />)}</div>}
    </article>
  );
}

export default function ThreadPage() {
  const [posts, setPosts] = useState<ThreadPost[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [user, setUser] = useState<ThreadUser | null>(null);
  const [profile, setProfile] = useState<ThreadProfile | null>(null);
  const [profileHandle, setProfileHandle] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loginBusy, setLoginBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<ComposerTarget>({ mode: 'create' });
  const [body, setBody] = useState('');
  const [existingImages, setExistingImages] = useState<ThreadImage[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const previews = useMemo(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })), [files]);
  const loginAbortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)), [previews]);

  const loadFeed = useCallback(async (cursor?: number) => {
    setLoading(true);
    setError('');
    try {
      const result = profileHandle ? await listThreadProfilePosts(profileHandle, cursor) : await listThreadPosts(cursor);
      if (profileHandle) setProfile(await getThreadProfile(profileHandle));
      setPosts((current) => cursor ? [...current, ...result.posts] : result.posts);
      setNextCursor(result.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the feed.');
    } finally { setLoading(false); }
  }, [profileHandle]);

  useEffect(() => { void loadFeed(); }, [loadFeed]);
  useEffect(() => {
    if (!hasThreadSession()) return;
    void getThreadUser().then(setUser).catch(() => logoutThread());
  }, []);

  const resetComposer = () => {
    setTarget({ mode: 'create' });
    setBody('');
    setExistingImages([]);
    setFiles([]);
  };

  const selectTarget = (next: ComposerTarget) => {
    setTarget(next);
    setBody(next.mode === 'edit' ? next.post.body : '');
    setExistingImages(next.mode === 'edit' ? next.post.images : []);
    setFiles([]);
    document.querySelector<HTMLTextAreaElement>('.thread-composer textarea')?.focus();
  };

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const candidates = Array.from(incoming);
    const accepted = candidates.filter((file) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) && file.size <= MAX_IMAGE_BYTES);
    if (accepted.length !== candidates.length) setError('Use PNG, JPEG, GIF or WebP images up to 5 MB each.');
    else setError('');
    setFiles((current) => [...current, ...accepted].slice(0, Math.max(0, MAX_IMAGES - existingImages.length)));
  };

  const login = async () => {
    loginAbortRef.current?.abort('new login request');
    const controller = new AbortController();
    loginAbortRef.current = controller;
    setLoginBusy(true);
    setError('');
    try { setUser(await beginThreadLogin(controller.signal)); await loadFeed(); }
    catch (loginError) {
      if (!controller.signal.aborted) setError(loginError instanceof Error ? loginError.message : 'Could not sign in.');
    } finally { setLoginBusy(false); }
  };

  const openProfile = async (handle: string) => {
    setProfileHandle(handle);
    setProfileLoading(true);
    setError('');
    try { setProfile(await getThreadProfile(handle)); }
    catch (profileError) { setError(profileError instanceof Error ? profileError.message : 'Could not load the profile.'); }
    finally { setProfileLoading(false); }
  };

  const closeProfile = () => {
    setProfileHandle('');
    setProfile(null);
  };

  const submit = async () => {
    if (!user) { await login(); return; }
    if (!body.trim() && existingImages.length + files.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const uploaded = await Promise.all(files.map(uploadThreadImage));
      const imageIds = [...existingImages.map((image) => image.id), ...uploaded.map((image) => image.id)];
      if (target.mode === 'edit') await updateThreadPost(target.post.id, { body, imageIds });
      else await createThreadPost({ body, imageIds, ...(target.mode === 'reply' ? { parentId: target.post.id } : {}) });
      resetComposer();
      await loadFeed();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the post.');
    } finally { setSaving(false); }
  };

  return (
    <div className="thread-page">
      <header className="thread-topbar" data-tauri-drag-region>
        <div><strong>BBARIT Thread</strong><span>Share notes, ideas and images</span></div>
        {user ? (
          <div className="thread-user">
            {user.avatar_url ? <img src={user.avatar_url} alt="" /> : <UserRound size={16} />}
            <button type="button" className="thread-current-user" onClick={() => void openProfile(user.github_login)}>{user.name || user.github_login}</button>
            <button type="button" title="Sign out" onClick={() => { logoutThread(); setUser(null); void loadFeed(); }}><LogOut size={14} /></button>
          </div>
        ) : (
          <button type="button" className="thread-login" disabled={loginBusy} onClick={() => void login()}>
            {loginBusy ? <RefreshCw size={14} className="spin" /> : <LogIn size={14} />} Join / Sign in with GitHub
          </button>
        )}
      </header>

      <div className="thread-layout">
        <main className="thread-feed">
          <div className="thread-feed-title"><strong>{profileHandle ? `@${profileHandle}'s posts` : 'Public feed'}</strong><div>{profileHandle && <button type="button" title="Back to public feed" onClick={closeProfile}><X size={14} /></button>}<button type="button" title="Refresh" onClick={() => void loadFeed()}><RefreshCw size={14} /></button></div></div>
          {error && <div className="thread-error">{error}</div>}
          {!loading && posts.length === 0 && <div className="thread-empty">No posts yet. Start the first thread.</div>}
          {posts.map((post) => <ThreadPostCard key={post.id} post={post} userId={user?.id} onReply={(item) => selectTarget({ mode: 'reply', post: item })} onEdit={(item) => selectTarget({ mode: 'edit', post: item })} onProfile={(handle) => void openProfile(handle)} onSignIn={() => void login()} onDeleted={(id) => setPosts((items) => items.filter((item) => item.id !== id))} />)}
          {loading && <div className="thread-loading"><RefreshCw size={18} className="spin" /> Loading feed</div>}
          {!loading && nextCursor && <button type="button" className="thread-more" onClick={() => void loadFeed(nextCursor)}>Load older posts</button>}
        </main>

        <aside className="thread-compose-pane">
          {(profileLoading || profile) && <section className="thread-profile-card">
            {profileLoading ? <div className="thread-loading"><RefreshCw size={16} className="spin" /> Loading profile</div> : profile && <>
              <div className="thread-profile-main">{profile.author.avatarUrl ? <img src={profile.author.avatarUrl} alt="" /> : <UserRound size={24} />}<div><strong>{profile.author.name}</strong><span>@{profile.author.handle}</span></div><button type="button" onClick={closeProfile}><X size={14} /></button></div>
              <div className="thread-profile-stats"><span><strong>{profile.postCount}</strong> posts</span><span><strong>{profile.replyCount}</strong> replies</span><span>Joined {new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' }).format(new Date(profile.joinedAt))}</span></div>
            </>}
          </section>}
          <div className="thread-composer">
            <div className="thread-composer-head">
              <strong>{target.mode === 'edit' ? 'Edit post' : target.mode === 'reply' ? `Reply to @${target.post.author.handle}` : 'New post'}</strong>
              {target.mode !== 'create' && <button type="button" onClick={resetComposer}><X size={14} /></button>}
            </div>
            {!user && <button type="button" className="thread-auth-callout" onClick={() => void login()}><LogIn size={18} /> Join or sign in to publish.</button>}
            <textarea value={body} onChange={(event) => setBody([...event.target.value].slice(0, MAX_BODY).join(''))} disabled={!user || saving} placeholder="What are you building?" />
            <div className="thread-image-previews">
              {existingImages.map((image) => (
                <div key={image.id}><img src={threadAssetUrl(image.url)} alt="" /><button type="button" onClick={() => setExistingImages((items) => items.filter((item) => item.id !== image.id))}><X size={12} /></button></div>
              ))}
              {previews.map((preview) => (
                <div key={`${preview.file.name}-${preview.file.lastModified}`}><img src={preview.url} alt="" /><button type="button" onClick={() => setFiles((items) => items.filter((file) => file !== preview.file))}><X size={12} /></button></div>
              ))}
            </div>
            <div className="thread-composer-actions">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => addFiles(event.target.files)} />
              <button type="button" disabled={!user || saving || existingImages.length + files.length >= MAX_IMAGES} onClick={() => fileRef.current?.click()}><ImagePlus size={15} /> Images</button>
              <span>{[...body].length}/{MAX_BODY} · {existingImages.length + files.length}/{MAX_IMAGES}</span>
              <button type="button" className="thread-submit" disabled={!user || saving || (!body.trim() && existingImages.length + files.length === 0)} onClick={() => void submit()}>
                {saving ? <RefreshCw size={15} className="spin" /> : <Send size={15} />} {target.mode === 'edit' ? 'Save' : 'Post'}
              </button>
            </div>
          </div>
          <a className="thread-public-link" href={THREAD_WEB_URL} target="_blank" rel="noreferrer">Open the read-only website feed ↗</a>
        </aside>
      </div>
    </div>
  );
}
