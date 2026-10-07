//! One cancellation source shared by the session control lane and its worker.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Clone, Default)]
pub struct Token {
    cancelled: Arc<AtomicBool>,
}
impl Token {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}
#[derive(Clone, Default)]
pub struct Flag {
    token: Token,
}
impl Flag {
    pub fn cancel(&self) {
        self.token.cancelled.store(true, Ordering::Release);
    }
    pub(crate) fn reset(&self) {
        self.token.cancelled.store(false, Ordering::Release);
    }
    pub fn token(&self) -> Token {
        self.token.clone()
    }
}
impl std::ops::Deref for Flag {
    type Target = Token;
    fn deref(&self) -> &Token {
        &self.token
    }
}
