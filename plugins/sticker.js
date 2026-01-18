const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

module.exports = {
    name: 'sticker',
    description: 'Convert an image or video to sticker with custom name',
    aliases: ['s', 'stkr', 'take'],
    tags: ['main'],
    command: /^(sticker|take|s|stkr)$/i,

    async execute(sock, m, args) {
        try {
            const command = m.text.match(this.command)[1].toLowerCase();
            
            if (command === 'take' && !args.trim()) {
                return await sock.sendMessage(
                    m.from,
                    { text: '📝 *Usage:*\n`.take [sticker name]`\n\nExample:\n`.take My Cool Sticker`' },
                    { quoted: m }
                );
            }

            const target = m.quoted || m;
            let mediaBuffer;

            if (typeof target.download === 'function') {
                mediaBuffer = await target.download();
            } else if (target.message) {
                mediaBuffer = await downloadMediaMessage(
                    { message: target.message },
                    'buffer',
                    {},
                    sock
                );
            }

            if (!mediaBuffer && command === 'take' && args.trim()) {
                return await sock.sendMessage(
                    m.from,
                    { text: '❌ Please reply to an image or video when using `.take [name]`\n\nExample: Reply to an image and type `.take My Sticker`' },
                    { quoted: m }
                );
            }

            if (!mediaBuffer) {
                return await sock.sendMessage(
                    m.from,
                    { text: '📌 *Sticker Maker*\n\nSend or reply to an image/video with:\n• `.sticker` - Default XLIOCN sticker\n• `.take [name]` - Custom sticker name\n\nExample: Reply to media and type `.take My Pack`' },
                    { quoted: m }
                );
            }

            let packName = 'XLIOCN V2';
            let authorName = 'XLIOCN V2 ᴍᴜʟᴛɪᴅᴇᴠɪᴄᴇ';
            
            if (command === 'take' && args.trim()) {
                packName = args.trim();
                authorName = m.pushName || 'WhatsApp User';
            }

            const sticker = new Sticker(mediaBuffer, {
                pack: packName,
                author: authorName,
                type: StickerTypes.DEFAULT,
                quality: 80,
                categories: ['🤩', '🎉'],
            });

            const stickerBuffer = await sticker.toBuffer();
            
            const successMsg = command === 'take' && args.trim() 
                ? `✅ Sticker created with name: *${packName}*`
                : `✅ Sticker created with default XLIOCN name`;
            
            await sock.sendMessage(
                m.from,
                { 
                    sticker: stickerBuffer,
                    text: successMsg
                },
                { quoted: target.key ? target : undefined }
            );

            console.log(`✅ Sticker sent in chat ${m.from} | Pack: ${packName}`);
        } catch (err) {
            console.error('❌ Sticker command error:', err);
            await sock.sendMessage(
                m.from,
                { text: 'Failed to create sticker. See console for details.' },
                { quoted: m }
            );
        }
    }
};
