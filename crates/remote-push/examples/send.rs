//! `cargo run --example send -- <vapid-private-or-new> <subscription.json> <message>`: one real push.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let vapid = if a[1] == "new" { remote_push::Vapid::generate() } else { remote_push::Vapid::from_private(&a[1]).unwrap() };
    if a.len() < 4 {
        println!("{{\"private\":\"{}\",\"public\":\"{}\"}}", vapid.private(), vapid.public());
        return;
    }
    let sub: remote_push::Subscription = serde_json::from_str(&std::fs::read_to_string(&a[2]).unwrap()).unwrap();
    println!("status {:?}", vapid.send(&sub, a[3].as_bytes(), "mailto:remote@cockpit.invalid"));
}
