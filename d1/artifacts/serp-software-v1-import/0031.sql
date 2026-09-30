INSERT INTO listings (id, site_id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES ('lst_1315515329ce9b52e078e3f6', 'serp.software', 'shooshtime-downloader', 'Shooshtime Video Downloader', 'Save supported Shooshtime videos directly from the watch page using a button-driven browser extension workflow.', 'https://serp.ly/shooshtime-downloader', '## Overview

Shooshtime Downloader is a browser extension that lets you save supported videos from Shooshtime video pages. Open any compatible Shooshtime video, let the player load, and use the page-level button or popup to detect available media options. The extension works inside your browser so you do not need external downloader sites or desktop tools.

- Save supported Shooshtime videos directly from the watch page
- Button-driven detection that works after the player loads
- Browser-based workflow with no external tools required
- Quality selection when multiple variants are available
- Clean MP4 output for easy playback and archiving

## Why Shooshtime Downloader

Shooshtime video pages do not always expose a simple right-click-save file. The final media URL often appears only after the player initializes, and generic download tools may pick up previews, thumbnails, or other non-video requests instead of the actual content you want. This makes it difficult to save videos directly from the browser without extra steps.

Shooshtime Downloader solves this by working inside the Shooshtime page flow. It matches Shooshtime host patterns, detects media after the player has loaded, and presents the available options through a clear button-driven interface. You stay inside the browser the whole time, with no need to copy URLs into external tools or desktop downloaders.

## Features

- Shooshtime-specific host matching for shooshtime.com and its subdomains
- Button-driven download entry point on supported video pages
- Media detection that activates after the player loads
- Quality selection when the page exposes multiple media variants
- Popup interface for reviewing detected options
- In-page download progress manager
- Context menu support for quick access on video pages
- Clean MP4 output for standard playback

## How It Works

1. Install the extension from the latest release.
2. Open Shooshtime and go to a supported video page.
3. Start playback so the extension can detect the media.
4. Open the popup or use the on-page controls.
5. Choose the quality option you want.
6. Start the download and wait for the MP4 export to finish.
7. Save the final file locally.

## Step-by-Step Tutorial: How to Download Videos from Shooshtime

1. Open your browser and install Shooshtime Downloader from the latest GitHub release.
2. Navigate to Shooshtime and find a video you want to save.
3. Click on the video to open its dedicated watch page.
4. Press play so the Shooshtime player initializes and loads the media.
5. Look for the download button that appears on the video page.
6. Click the button or open the extension popup to see detected media options.
7. Select your preferred quality from the available choices.
8. Click download and wait for the file to save to your computer.

## Supported Formats

- Input: Supported video sources as exposed by the Shooshtime player on compatible watch pages
- Output: MP4

Saved files use MP4 so they are easier to replay on standard media players, move between devices, or archive locally.

## Who It''s For

- Shooshtime viewers who want to save videos for offline playback
- Users who prefer browser extensions over external downloader sites
- People who need to archive Shooshtime content they have rights to keep
- Anyone looking for a button-driven download workflow on video pages

## Common Use Cases

- Save a Shooshtime video to watch later without an internet connection
- Keep a personal copy of content you have permission to archive
- Avoid copying URLs into third-party downloader websites
- Download media directly from the video page without desktop tools
- Review available quality options before saving a file

## Troubleshooting

**The download button does not appear on the video page.**
Make sure the video player has fully loaded and playback has started. The extension needs the player to initialize before it can detect media.

**The extension says no media was detected.**
Try refreshing the page and starting playback again. Some videos may take a moment to expose their media sources after the player loads.

**The download starts but fails partway through.**
Check your internet connection and make sure the Shooshtime page remains open during the download. A stable connection helps ensure complete file transfers.

**I cannot see the extension popup.**
Verify the extension is installed correctly and pinned to your browser toolbar. You may need to restart your browser after installation.

**The quality options do not match what I expected.**
The extension shows only the media variants that the Shooshtime player exposes on that specific video page. Available qualities depend on the source file.

## Trial & Access

- Includes **3 free downloads** so you can test the workflow first
- Email sign-in uses secure one-time password verification
- No credit card required for the trial
- Unlimited downloads are available with a paid license

Start here: [https://serp.ly/shooshtime-downloader](https://serp.ly/shooshtime-downloader)

## Installation Instructions

1. Open the latest release page: [GitHub Releases](https://github.com/serpapps/shooshtime-downloader/releases/latest)
2. Download the correct build for your browser.
3. Install the extension.
4. Open a supported Shooshtime page.
5. Use the popup to detect and download the media.

## Notes

- Only download content you own or have explicit permission to save
- An internet connection is required for downloads
- The extension works best when the Shooshtime player has fully loaded before detection
- Supported media options depend on what the page exposes

## About Shooshtime

Shooshtime is a video-sharing platform that hosts a wide variety of content across many categories. Shooshtime Downloader helps users save supported videos directly from the browser for offline access and personal archiving.

## FAQ

### How do I download a Shooshtime video?

Open a supported Shooshtime video page, let the player load, then use the extension button or popup to choose a detected media option and start the download.

### Do I need to press play first?

Yes. The extension detects media after the Shooshtime player initializes, so starting playback helps ensure all available options are found.

### What formats does the extension support?

The extension outputs MP4 files. Input formats depend on what the Shooshtime player exposes on the video page.

### Can I use this extension on any Shooshtime video?

The extension works on supported Shooshtime video pages. Only download content you have the right to save.

### How many downloads do I get with the trial?

The trial includes 3 free downloads so you can test the workflow before purchasing unlimited access.', NULL, NULL, 0, 0, 1, 'draft', '2026-05-07', 238, 'legacy-json-migration-v1', 'serp-software-v1:e0f1f70aa986813cccd1f379a24bdc8dc27d546e67572d08fea1a4832c5a689e', '2026-07-13T00:00:00.000Z', 'bced28e278826b22dab19c54736ab742a790f187520dec5f84c60fc4033ec327', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_1315515329ce9b52e078e3f6', id, 0, 1 FROM categories WHERE site_id = 'serp.software' AND slug = 'adult';
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_1315515329ce9b52e078e3f6', id, 1, 0 FROM categories WHERE site_id = 'serp.software' AND slug = 'video-downloaders';
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_1315515329ce9b52e078e3f6', 'Install browser extension', 'https://serp.ly/shooshtime-downloader', 0);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_1315515329ce9b52e078e3f6', 'SERPX', 'https://serpx.link/shooshtime-downloader', 1);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_1315515329ce9b52e078e3f6', 'SERP', 'https://serp.co/products/shooshtime-downloader/reviews/', 2);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_1315515329ce9b52e078e3f6', 'SERP AI', 'https://serp.ai/products/shooshtime-downloader/reviews/', 3);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_1315515329ce9b52e078e3f6', 'Browser Extensions', 'https://browserextensions.io/products/shooshtime-downloader/', 4);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_1315515329ce9b52e078e3f6', 'Latest Release', 'https://github.com/serpapps/shooshtime-downloader/releases/latest', 5);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_1315515329ce9b52e078e3f6', 'GitHub Issues', 'https://github.com/serpapps/shooshtime-downloader/issues', 6);
INSERT INTO listings (id, site_id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES ('lst_354384c7bd93a1734a3eea62', 'serp.software', 'sinpartytube-downloader', 'Sinpartytube Video Downloader', 'A browser extension downloader for SinParty Tube that lets you save videos from sinparty.com as MP4 files.', 'https://serp.ly/sinpartytube-downloader', '## Overview

Sinpartytube Downloader is a practical tool for capturing videos from SinParty Tube pages directly in your browser. Whether you want to build a personal collection or watch content offline, this extension detects media on supported SinParty video pages and exports it as standard MP4 files you can keep and replay anywhere.

- Works on SinParty Tube video pages at sinparty.com
- Detects and downloads media in MP4 format
- Simple popup interface for quality selection
- Lightweight extension that does not slow down your browser
- Multiple quality options where available

## Why Sinpartytube Downloader

SinParty Tube hosts a large library of adult video content, but the platform does not offer a built-in way to download videos for offline viewing. If you want to save a specific scene to watch later without an internet connection, you are left searching for third-party tools that often come with malware risks, confusing interfaces, or unreliable results.

Sinpartytube Downloader solves this by adding a clean download button directly to your browser. Instead of messing with sketchy websites or command-line tools, you simply install the extension, open a SinParty Tube video page, and let the extension handle the rest. The output is a standard MP4 file that works on any device or media player.

## Features

- One-click download from SinParty Tube video pages
- MP4 output format for broad compatibility
- Quality selection when multiple streams are available
- Works on localized SinParty Tube routes, including /de/videos/ pages
- Lightweight extension with minimal resource usage
- Clean popup interface that stays out of your way
- Supports Chrome, Edge, Brave, and Firefox browsers
- Regular updates through GitHub Releases

## How It Works

1. Install the extension from the latest release.
2. Open SinParty Tube and go to a supported video page.
3. Start playback so the extension can detect the media.
4. Open the popup or use the on-page controls.
5. Choose the quality option you want.
6. Start the download and wait for the MP4 export to finish.
7. Save the final file locally.

## Step-by-Step Tutorial: How to Download Videos from Sinpartytube

1. Install the Sinpartytube Downloader extension using the instructions in the Installation section below.
2. Open your browser and navigate to sinparty.com/tube.
3. Browse or search for a video you want to download.
4. Click on the video thumbnail to open its dedicated page.
5. Press the play button on the video player so the extension can detect the media stream.
6. Click the Sinpartytube Downloader icon in your browser toolbar.
7. In the popup window, select your preferred video quality from the available options.
8. Click the download button and wait for the MP4 file to be saved to your computer.

## Supported Formats

- Input: Video streams detected on SinParty Tube pages at sinparty.com, including localized routes like /de/videos/
- Output: MP4

Saved files use MP4 so they are easier to replay on standard media players, move between devices, or archive locally.

## Who It''s For

- Users who want to watch SinParty Tube videos offline without an internet connection
- Collectors building a personal library of favorite scenes
- People with slow or unreliable internet who prefer to download videos for later
- Anyone who wants a simple, browser-based download tool without external software

## Common Use Cases

- Saving a specific scene to watch on a commute or flight
- Building a curated offline collection of SinParty Tube content
- Archiving favorite videos before they are removed from the platform
- Sharing downloaded clips with consenting partners on local media
- Reducing data usage by downloading over Wi-Fi instead of streaming on mobile

## Troubleshooting

**The extension does not appear on SinParty Tube pages.**
Make sure you have installed the correct build for your browser from the latest release and that the extension is enabled in your browser settings.

**The download button is grayed out or inactive.**
The media may not have been detected yet. Try starting video playback first, then open the popup again.

**The download fails or produces a broken file.**
Check your internet connection and try refreshing the page. If the issue persists, the video format may not be supported by this version of the extension.

**I cannot find the extension after installing from GitHub Releases.**
Some browsers require you to manually enable developer mode extensions. Check your browser''s extension management page and ensure the extension is toggled on.

**The extension works on some videos but not others.**
SinParty Tube may use different video formats for different content. The extension supports common stream types but may not cover every format on the platform.

## Trial & Access

- Includes **3 free downloads** so you can test the workflow first
- Email sign-in uses secure one-time password verification
- No credit card required for the trial
- Unlimited downloads are available with a paid license

Start here: [https://serp.ly/sinpartytube-downloader](https://serp.ly/sinpartytube-downloader)

## Installation Instructions

1. Open the latest release page: [GitHub Releases](https://github.com/serpapps/sinpartytube-downloader/releases/latest)
2. Download the correct build for your browser.
3. Install the extension.
4. Open a supported SinParty Tube page.
5. Use the popup to detect and download the media.

## Notes

- Only download content you own or have explicit permission to save
- An internet connection is required for downloads
- SinParty Tube video formats may change over time, which could affect compatibility
- Always download the latest version from GitHub Releases for best results

## About Sinpartytube

SinParty Tube is the video section of sinparty.com, a platform hosting adult content with a focus on vintage and classic scenes. The Sinpartytube Downloader extension makes it easy to save those videos for offline access, giving you more control over your viewing experience.

## FAQ

### Is this extension free to use?

The extension includes 3 free downloads to test the workflow. Unlimited downloads require a paid license.

### Does it work on all SinParty Tube videos?

The extension is designed for SinParty Tube video pages at sinparty.com. It works on many common formats but may not support every video type on the platform.

### Can I download multiple videos at once?

The extension processes one video at a time. You can start a new download after the current one finishes.

### Is my privacy protected when using this extension?

The extension only interacts with SinParty Tube pages you visit. No personal data is collected or sent to third parties.

### What browsers are supported?

Chrome, Edge, Brave, and Firefox are supported. Check the latest release for specific build files.', NULL, NULL, 0, 0, 1, 'draft', '2026-05-07', 239, 'legacy-json-migration-v1', 'serp-software-v1:e0f1f70aa986813cccd1f379a24bdc8dc27d546e67572d08fea1a4832c5a689e', '2026-07-13T00:00:00.000Z', '7f2f3338f2ad801d9b728334342c7c3a493d9e24bc1561c844eda1f90615c50a', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_354384c7bd93a1734a3eea62', id, 0, 1 FROM categories WHERE site_id = 'serp.software' AND slug = 'adult';
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_354384c7bd93a1734a3eea62', id, 1, 0 FROM categories WHERE site_id = 'serp.software' AND slug = 'video-downloaders';
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_354384c7bd93a1734a3eea62', 'Install browser extension', 'https://serp.ly/sinpartytube-downloader', 0);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_354384c7bd93a1734a3eea62', 'SERPX', 'https://serpx.link/sinpartytube-downloader', 1);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_354384c7bd93a1734a3eea62', 'SERP', 'https://serp.co/products/sinpartytube-downloader/reviews/', 2);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_354384c7bd93a1734a3eea62', 'SERP AI', 'https://serp.ai/products/sinpartytube-downloader/reviews/', 3);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_354384c7bd93a1734a3eea62', 'Browser Extensions', 'https://browserextensions.io/products/sinpartytube-downloader/', 4);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_354384c7bd93a1734a3eea62', 'Latest Release', 'https://github.com/serpapps/sinpartytube-downloader/releases/latest', 5);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_354384c7bd93a1734a3eea62', 'GitHub Issues', 'https://github.com/serpapps/sinpartytube-downloader/issues', 6);
INSERT INTO listings (id, site_id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES ('lst_cd043df8df04a7f66f8fe7b7', 'serp.software', 'siska-downloader', 'Siska Video Downloader', 'Browser extension downloader for Siska. Chrome, Edge, Brave, Firefox.', 'https://serp.ly/siska-downloader', '## Overview

Siska Downloader is a browser extension that helps you save videos from Siska video detail pages directly to your computer. It works with the Siska video player to detect available media and export it as MP4 files you can keep and watch offline.

- Built around Siska video detail pages with numeric video IDs
- Works directly through your browser without extra software
- Detects media through the page player for reliable capture
- Exports videos as standard MP4 files for easy playback
- Simple button-driven workflow from page to download

## Why Siska Downloader

Siska video pages use a player-based delivery system where media is streamed through the page rather than offered as a direct download link. This means saving a video for offline use usually involves inspecting network requests or using screen recording tools that reduce quality.

Siska Downloader works with the page player to detect the media stream and offer it as a downloadable file. Instead of tracing CDN requests manually or settling for lower-quality recordings, you can use the extension to capture the video directly from the player in its original format.

## Features

- Detects videos on Siska video detail pages automatically
- Works with the page player for reliable media capture
- Exports videos as standard MP4 files
- Simple button-driven workflow from detection to download
- Saves files to a dedicated Siska folder for easy organization
- Supports multiple browser environments including Chrome, Edge, Brave, and Firefox
- Lightweight extension that runs only when needed
- No external software or accounts required for basic use

## How It Works

1. Install the extension from the latest release.
2. Open Siska and go to a supported video page.
3. Start playback so the extension can detect the media.
4. Open the popup or use the on-page controls.
5. Choose the quality option you want.
6. Start the download and wait for the MP4 export to finish.
7. Save the final file locally.

## Step-by-Step Tutorial: How to Download Videos from Siska

1. Visit the Siska video page you want to download from.
2. Make sure the video player is visible and the page has fully loaded.
3. Start playing the video so the player exposes the media stream.
4. Click the extension icon in your browser toolbar to open the popup.
5. Wait for the extension to detect the available video on the page.
6. Select your preferred quality option from the list shown.
7. Click the download button to begin the export process.
8. Save the MP4 file to your preferred location when prompted.

## Supported Formats

- Input: Videos streamed through the Siska player on video detail pages
- Output: MP4

Saved files use MP4 so they are easier to replay on standard media players, move between devices, or archive locally.

## Who It''s For

- Siska users who want to save videos for offline viewing
- People who prefer browser-based tools over standalone download software
- Users who want a simple button-driven workflow without technical setup
- Anyone looking to archive Siska videos without relying on screen recording

## Common Use Cases

- Saving Siska videos to watch later without an internet connection
- Building a personal archive of favorite Siska content
- Transferring videos to other devices for offline playback
- Backing up videos that may be removed from the platform
- Creating a local library of Siska content for personal use

## Troubleshooting

**The extension does not detect any video on the page**
Make sure the video player is visible and playback has started. The extension needs the player to expose media before it can detect the stream.

**The download button does not appear**
Try refreshing the page and starting the video again. Make sure you are on a supported Siska video detail page with a numeric video ID.

**The download fails or produces a broken file**
Check your internet connection and try again. Some videos may have restrictions that prevent downloading the full stream.

**The popup shows no quality options**
The available qualities depend on what the Siska player exposes for that specific video. Try a different video to confirm the extension is working.

**The extension does not work after updating**
Clear your browser cache and reload the Siska page. Make sure you have the latest version installed from the releases page.

## Trial & Access

- Includes **3 free downloads** so you can test the workflow first
- Email sign-in uses secure one-time password verification
- No credit card required for the trial
- Unlimited downloads are available with a paid license

Start here: [https://serp.ly/siska-downloader](https://serp.ly/siska-downloader)

## Installation Instructions

1. Open the latest release page: [GitHub Releases](https://github.com/serpapps/siska-downloader/releases/latest)
2. Download the correct build for your browser.
3. Install the extension.
4. Open a supported Siska page.
5. Use the popup to detect and download the media.

## Notes

- Only download content you own or have explicit permission to save
- An internet connection is required for downloads
- Siska video pages may use separate CDN hosts for media delivery
- The extension works best when the video player is actively playing

## About Siska

Siska is a video platform that hosts content through video detail pages with numeric video IDs. Siska Downloader helps you save videos from these pages directly through your browser without needing to trace media streams manually.

## FAQ

### What Siska pages does this extension work with?

It works with Siska video detail pages that use the video.php route with a numeric video ID parameter.

### Do I need to create an account to use the extension?

You will need to sign in with your email to activate the trial or paid license. A one-time password is sent for secure verification.

### Can I download multiple videos at the same time?

The extension handles one download at a time. Start a new download after the current one finishes.

### Does the extension work on mobile browsers?

The extension is designed for desktop browsers. Mobile browser support is not confirmed.

### What happens when my trial downloads run out?

You can purchase a paid license to continue downloading. Your trial downloads reset if you sign in with a new account.', NULL, NULL, 0, 0, 1, 'draft', '2026-05-07', 240, 'legacy-json-migration-v1', 'serp-software-v1:e0f1f70aa986813cccd1f379a24bdc8dc27d546e67572d08fea1a4832c5a689e', '2026-07-13T00:00:00.000Z', '566eca90bd6423d9d37b641364fb8c2ec1ce2c8332980c7a70acf45a3c33bdc1', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_cd043df8df04a7f66f8fe7b7', id, 0, 1 FROM categories WHERE site_id = 'serp.software' AND slug = 'adult';
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_cd043df8df04a7f66f8fe7b7', id, 1, 0 FROM categories WHERE site_id = 'serp.software' AND slug = 'video-downloaders';
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_cd043df8df04a7f66f8fe7b7', 'Install browser extension', 'https://serp.ly/siska-downloader', 0);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_cd043df8df04a7f66f8fe7b7', 'SERPX', 'https://serpx.link/siska-downloader', 1);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_cd043df8df04a7f66f8fe7b7', 'SERP', 'https://serp.co/products/siska-downloader/reviews/', 2);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_cd043df8df04a7f66f8fe7b7', 'SERP AI', 'https://serp.ai/products/siska-downloader/reviews/', 3);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_cd043df8df04a7f66f8fe7b7', 'Browser Extensions', 'https://browserextensions.io/products/siska-downloader/', 4);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_cd043df8df04a7f66f8fe7b7', 'Latest Release', 'https://github.com/serpapps/siska-downloader/releases/latest', 5);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_cd043df8df04a7f66f8fe7b7', 'GitHub Issues', 'https://github.com/serpapps/siska-downloader/issues', 6);
INSERT INTO listings (id, site_id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES ('lst_67b5bc7ee30cc9a2ae2bcd1f', 'serp.software', 'skillshare-downloader', 'Skillshare Downloader', 'Cancel Skillshare without losing your favorite classes. Download them as MP4s you can keep and rewatch anytime.', 'https://serp.ly/skillshare-downloader', '## Overview

You found the perfect Skillshare class on watercolor technique or logo design, followed along for weeks, and then your membership ran out. Now all the lessons are locked behind a paywall. Subscription-based learning means cancel and everything disappears. This extension lets you keep the classes that matter. Open any Skillshare class, hit the download button, and every lesson saves as an MP4 to your computer. Download them one by one or queue the entire class for automatic download.

Files are organized by class name and lesson number, so finding a specific technique demo three months later takes seconds. The extension grabs the best available quality up to 1080p and can save subtitle tracks alongside the videos.

Everything stays on your machine with no data uploaded anywhere, no personal information collected, and nothing touching external servers. Ideal for following along with creative tutorials offline, whether on a plane, at a coffee shop with unreliable WiFi, or working without browser tabs competing for your attention. Try 3 free downloads to see for yourself.

## Why It Exists

- Follow along with design tutorials offline using your creative software without tab switching to stream
- Build a curated library of creative classes to reference for ongoing projects
- Study illustration and photography techniques during travel without internet dependency
- Keep access to your favorite instructor classes even if your Skillshare membership changes

## Key Features

- Download video lessons from Skillshare classes across all creative categories
- Preserve original video quality up to 1080p without re-encoding
- Extract available subtitle tracks in SRT format
- Batch queue all lessons within a class for one-click sequential download
- Organize files by class name and lesson number automatically
- Automatic retry with resume on interrupted downloads
- Smart detection of Skillshare video player elements on class pages
- Download progress bar with speed and ETA indicators
- No personal data collection or external server communication
- Compatible with Chrome, Firefox, and Edge browsers

## How It Works

- Install the extension: Add Skillshare Downloader to your browser and pin it to your toolbar for quick access.
- Open a Skillshare class: Navigate to any Skillshare class page while logged in with your Skillshare membership.
- Download lessons: Click the download button for individual lessons or batch-queue all lessons in the class for one-click sequential download.
- Study and create offline: Videos save as MP4 files organized by class name and lesson number, ready for offline practice alongside your creative tools.

## Reviews

- Perfect for offline illustration practice (5/5): I follow several Skillshare illustration instructors and downloaded their entire class libraries. Now I can follow along in Procreate on my iPad while watching the lessons offline on my laptop. - Olivia Tran
- Downloaded Skillshare classes for a month of travel (4.9/5): As a freelance photographer, I downloaded about 20 Skillshare photography classes to study during a month-long trip through Southeast Asia with spotty internet. - Matteo Rossi
- Batch queuing makes Skillshare downloads effortless (4.8/5): The batch download is key. A typical Skillshare class has 10-20 lessons and being able to queue them all at once saves me from clicking through each one individually. - Brianna Cole

## Platform Support

### Browsers

- Chrome
- Firefox
- Edge

### Operating Systems

- Windows
- macOS
- Linux

### Supported Content

- Skillshare class videos across all creative categories
- Design, illustration, photography, and video editing classes
- Subtitle tracks in SRT format where available
- All instructors and class lengths

### Not Supported

- Safari and mobile browsers
- Class project files, worksheets, and resource links
- Skillshare community features and discussions
- Content requiring a membership you do not have

## Privacy and Permissions

Supported regions: Worldwide.

Limitations:
- Only downloads video lesson content from Skillshare classes.
- Class project files, worksheets, and resources must be downloaded directly from Skillshare.
- You must be logged in with an active Skillshare membership.
- Video quality up to 1080p depending on what the instructor uploaded.
- Safari and mobile browsers are not supported.
- Desktop browser extension only — does not store personal data or transmit to external servers.

Permissions:
- activeTab: Required to scan the active Skillshare class page for video player elements and extract lesson video URLs.
- downloads: Needed to save video and subtitle files to your local downloads folder.
- storage: Used to save download preferences and batch queue state between browser sessions.

## FAQ

### Does this work with Skillshare Premium classes?

The extension works with video content loaded in your browser during an active Skillshare session. If you can watch a class in your browser, the extension can detect and download the video lessons.

### Can I download all lessons in a Skillshare class at once?

Yes. You can queue all lesson videos within a class for sequential download. The extension processes each lesson one at a time and saves them numbered in order.

### Does it download class project files and resources?

The extension focuses on video lesson content. Class descriptions, project briefs, and resource links are part of the Skillshare web interface and are not captured as downloadable files.

### What about Skillshare classes that have worksheets or templates?

If worksheets or templates are provided as downloadable links within the class page, you can download those directly from Skillshare. The extension specifically handles video content.

### Can I download classes from any Skillshare instructor?

Yes. The extension works across all Skillshare class pages regardless of the instructor, category, or class length.

### Is this legal?

DISCLAIMER: We are not attorneys and do not offer legal advice. Laws vary by country and platform. For any legal question please consult a qualified legal professional.

We give you full control over download speeds because we believe users should decide how they use their software.

That said, here are a few widely accepted best practices for safe, responsible downloading:

- Only download content you created, own, or have explicit permission from the rights holder to access.

- Protect your personal data by respecting platform rules and rate limits with reasonable download speeds to avoid automated abuse systems putting your account at risk.

- Protect your privacy by using a reputable VPN for IP protection before initiating downloads — this is the VPN we recommend & use.', NULL, NULL, 0, 0, 1, 'draft', '2026-05-07', 241, 'legacy-json-migration-v1', 'serp-software-v1:e0f1f70aa986813cccd1f379a24bdc8dc27d546e67572d08fea1a4832c5a689e', '2026-07-13T00:00:00.000Z', '0c8c1fe6b62d4e365aea57d53665c35da8efb0d4a6fa0d385b58a033cd3d34a8', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_67b5bc7ee30cc9a2ae2bcd1f', id, 0, 1 FROM categories WHERE site_id = 'serp.software' AND slug = 'video-downloaders';
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_67b5bc7ee30cc9a2ae2bcd1f', 'image', '/media/products/skillshare-downloader/skillshare-homepage.webp', 0);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_67b5bc7ee30cc9a2ae2bcd1f', 'image', '/media/products/skillshare-downloader/featured.webp', 1);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_67b5bc7ee30cc9a2ae2bcd1f', 'image', 'https://raw.githubusercontent.com/serpapps/skillshare-downloader/main/images/skillshare-downloader.gif', 2);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_67b5bc7ee30cc9a2ae2bcd1f', 'Install browser extension', 'https://serp.ly/skillshare-downloader', 0);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_67b5bc7ee30cc9a2ae2bcd1f', 'SERP Apps', 'https://apps.serp.co/skillshare-downloader', 1);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_67b5bc7ee30cc9a2ae2bcd1f', 'GitHub repository', 'https://github.com/serpapps/skillshare-downloader', 2);
INSERT INTO listings (id, site_id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'serp.software', 'skool-downloader', 'Skool Video Downloader', 'Your Skool cohort won''t last forever — save every lesson and replay as MP4 before access disappears.', 'https://serp.ly/skool-video-downloader', '## Overview

Skool cohorts close. Memberships expire. When they do, every lesson, replay, and community video you relied on vanishes overnight.

This extension fixes that. Open any Skool classroom lesson, community post, or course module, press play on the video, click the extension icon, pick your quality, and the full video saves as an MP4 straight to your computer. It works regardless of which video player the creator used. The extension handles all of them automatically, so you never have to figure out where the video is actually hosted.

Queue up to three downloads at once and watch progress in real time. Every file is processed inside your browser, meaning your videos never pass through outside servers. Try it free with 3 downloads, no credit card needed. Works on Chrome, Edge, Firefox, Brave, Opera, and more.

## Why It Exists

- Archive Skool lessons and replays before cohorts or memberships end
- One extension handles every video platform on Skool — no need to install separate tools for Loom, Vimeo, YouTube, or Wistia
- Study offline during travel or low-connectivity periods without buffering
- Keep downloads private with all processing handled on your own device

## Key Features

- Multi-platform video detection — automatically identifies Skool native (Mux), Loom, Vimeo, YouTube, and Wistia videos
- Downloads from Skool classrooms, community posts, about pages, and course modules
- Understands Skool''s Next.js architecture — extracts video data directly from page props
- Quality selector showing all available resolutions per platform before you download
- Converts HLS streams to standard MP4 files entirely in your browser — no external tools needed
- Concurrent download queue supporting up to 3 simultaneous downloads
- Real-time download manager panel with progress bars, speed tracking, and cancel controls
- Member-only and private community content supported via your existing Skool login
- Auto-save as MP4 directly to your computer — no save-as dialogs
- Intelligent platform detection — auto-defers to Loom, Vimeo, YouTube, or Wistia handlers when embedded content is found

## How It Works

- Install the extension: Add Skool Video Downloader to Chrome, Edge, Firefox, Brave, or Opera and sign into your Skool community normally.
- Open the lesson or post: Navigate to any Skool classroom lesson, community post, or course module with a video.
- Play the video: Start the video so the extension can detect the stream — it automatically identifies Loom, Vimeo, YouTube, Wistia, or Skool''s native player.
- Choose quality and download: Click the extension icon, select your preferred resolution, and download. The video saves as MP4 directly to your computer.

## Reviews

- Perfect for cohort replays (5/5): I grabbed every classroom replay before the cohort closed. Segment counters let me know how long each download would take. - Mariah Keene
- Works with private communities (4.9/5): My membership site locks lessons to members only. The downloader honoured my login automatically and the MP4 quality is flawless. - Theo Richter
- Offline study made simple (4.8/5): I travel often and need lessons offline. This keeps downloads private and never asks for extra credentials. - Ines Navarro

## Platform Support

### Browsers

- Chrome
- Edge
- Firefox
- Brave
- Opera
- Whale
- Yandex

### Operating Systems

- Windows
- macOS
- Linux

### Supported Content

- Skool Classroom Lessons
- Community Video Posts
- Course Modules
- About Pages

### Detected Video Platforms

- Skool Native (Mux)
- Loom
- Vimeo
- YouTube
- Wistia

### Not Supported

- Mobile browsers
- Safari
- DRM-protected content
- Live streams (wait for recording)

## Privacy and Permissions

Supported regions: Worldwide.

Limitations:
- DRM-protected content is not supported.
- Live streams cannot be downloaded — wait for the recording to be available.
- Mobile and Safari browsers are not supported.
- You must press play on the video before the extension can detect the stream.
- You must already have access to the content. It does not bypass paywalls or permissions.
- Available quality depends on what the source platform and course creator uploaded.
- Requires email sign-in (OTP) for trial activation.

Permissions:
- downloads: Saves the finished MP4 to your downloads folder and keeps the progress tracker accurate for each video.
- storage: Stores licence activation, download manager state, and preferences locally so the extension stays ready between sessions.
- activeTab: Detects video players and embedded content on the tab you are viewing so the extension can identify the video platform and source.
- tabs: Allows the download manager to track active downloads across tab changes and restores state when you return.
- scripting: Injects multi-platform video detectors to extract stream manifests, quality variants, and page data from Skool, Loom, Vimeo, YouTube, and Wistia.
- offscreen: Converts HLS stream segments into MP4 files in the background using an offscreen document, keeping your lesson tab responsive.

## FAQ

### How do I download a video from Skool?

Open any Skool classroom, community post, or course page with a video. Press play on the video, then click the extension icon in your toolbar. Select your preferred quality and click Download — it saves as MP4.

### What video platforms does this support?

The extension detects videos from Skool''s native player (Mux-based), Loom, Vimeo, YouTube, and Wistia — all of which are commonly used within Skool communities and courses.

### Does it work with private communities or paid cohorts?

Yes. The extension works with any Skool community or course you can access in your browser. If you can see and play the video, you can download it.

### How many free downloads do I get?

3 free trial downloads after signing in with your email. No credit card required. Purchase a license for unlimited downloads.

### Can I download multiple videos at once?

Yes. The extension supports a concurrent download queue with up to 3 simultaneous downloads, each with its own progress bar and speed tracking.

### Why isn''t the extension finding my video?

Press play on the video first. The extension needs the stream to start before detection works. If the video is embedded from an external platform, make sure the embed has loaded fully. Refresh the page if issues persist.

### Which browsers are supported?

Chrome, Edge, Firefox, Brave, Opera, Whale, and Yandex on Windows, macOS, and Linux desktops. Safari is not supported.

### What format are downloaded videos?

All videos are saved as standard MP4 files that play on any device or media player. HLS streams are converted to MP4 automatically in your browser.

### Is my data private?

Yes. Video processing happens entirely in your browser. Authentication uses secure OTP — no passwords stored. No video data is sent to external servers.

### Is this legal?

DISCLAIMER: We are not attorneys and do not offer legal advice. Laws vary by country and platform. For any legal question please consult a qualified legal professional.

We give you full control over download speeds because we believe users should decide how they use their software.

That said, here are a few widely accepted best practices for safe, responsible downloading:

- Only download content you created, own, or have explicit permission from the rights holder to access.

- Protect your personal data by respecting platform rules and rate limits with reasonable download speeds to avoid automated abuse systems putting your account at risk.

- Protect your privacy by using a reputable VPN for IP protection before initiating downloads — this is the VPN we recommend & use.', NULL, NULL, 0, 0, 1, 'draft', '2026-05-07', 242, 'legacy-json-migration-v1', 'serp-software-v1:e0f1f70aa986813cccd1f379a24bdc8dc27d546e67572d08fea1a4832c5a689e', '2026-07-13T00:00:00.000Z', '8a0bd5174bfabb9f2f793d9ed20f933bb0a65a69977e25da61cbf5aa4931b863', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_75e1eb4d0e578018f42b43ec', id, 0, 1 FROM categories WHERE site_id = 'serp.software' AND slug = 'video-downloaders';
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'logo', '/listing-logos/serpdownloaders.com/skool-downloader.png', 0);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'image', 'https://raw.githubusercontent.com/serpapps/.github/refs/heads/main/sites/skool-video-downloader.jpg', 0);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'image', 'https://raw.githubusercontent.com/serpapps/skool-downloader/main/screenshots/skool%20video%20downloader%201.png', 1);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'image', 'https://raw.githubusercontent.com/serpapps/skool-downloader/main/screenshots/skool%20video%20downloader%202.png', 2);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'image', 'https://raw.githubusercontent.com/serpapps/skool-downloader/main/screenshots/skool%20video%20downloader%203.png', 3);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'image', 'https://raw.githubusercontent.com/serpapps/skool-downloader/main/images/skool-video-downloader.gif', 4);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'Install browser extension', 'https://serp.ly/skool-video-downloader', 0);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'SERP Apps', 'https://apps.serp.co/skool-video-downloader', 1);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'GitHub repository', 'https://github.com/serpapps/skool-downloader', 2);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'SERP Extensions', 'https://extensions.serp.co/extensions/serp/skool-video-downloader/', 3);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'ExtensionHub', 'https://www.extensionhub.io/extensions/Skool-Video-Downloader-882', 4);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'SERP', 'https://serp.co/products/skool-video-downloader/reviews/', 5);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'SERP AI', 'https://serp.ai/products/skool-video-downloader/reviews/', 6);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'Browser Extensions', 'https://browserextensions.io/products/skool-video-downloader/', 7);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'Product Hunt', 'https://www.producthunt.com/products/skool-com-downloader', 8);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_75e1eb4d0e578018f42b43ec', 'Chrome Web Store', 'https://chromewebstore.google.com/detail/skool-video-downloader-by/adjbknblejbhfmcefnhgkdboanoboimj', 9);
INSERT INTO listings (id, site_id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES ('lst_c435134518feee3cca2beac4', 'serp.software', 'skool-video-downloader', 'Skool Video Downloader', 'Your Skool cohort won''t last forever — save every lesson and replay as MP4 before access disappears.', 'https://serp.ly/skool-video-downloader', '## Overview

Skool cohorts close. Memberships expire. When they do, every lesson, replay, and community video you relied on vanishes overnight.

This extension fixes that. Open any Skool classroom lesson, community post, or course module, press play on the video, click the extension icon, pick your quality, and the full video saves as an MP4 straight to your computer. It works regardless of which video player the creator used. The extension handles all of them automatically, so you never have to figure out where the video is actually hosted.

Queue up to three downloads at once and watch progress in real time. Every file is processed inside your browser, meaning your videos never pass through outside servers. Try it free with 3 downloads, no credit card needed. Works on Chrome, Edge, Firefox, Brave, Opera, and more.

## Why It Exists

- Archive Skool lessons and replays before cohorts or memberships end
- One extension handles every video platform on Skool — no need to install separate tools for Loom, Vimeo, YouTube, or Wistia
- Study offline during travel or low-connectivity periods without buffering
- Keep downloads private with all processing handled on your own device

## Key Features

- Multi-platform video detection — automatically identifies Skool native (Mux), Loom, Vimeo, YouTube, and Wistia videos
- Downloads from Skool classrooms, community posts, about pages, and course modules
- Understands Skool''s Next.js architecture — extracts video data directly from page props
- Quality selector showing all available resolutions per platform before you download
- Converts HLS streams to standard MP4 files entirely in your browser — no external tools needed
- Concurrent download queue supporting up to 3 simultaneous downloads
- Real-time download manager panel with progress bars, speed tracking, and cancel controls
- Member-only and private community content supported via your existing Skool login
- Auto-save as MP4 directly to your computer — no save-as dialogs
- Intelligent platform detection — auto-defers to Loom, Vimeo, YouTube, or Wistia handlers when embedded content is found

## How It Works

- Install the extension: Add Skool Video Downloader to Chrome, Edge, Firefox, Brave, or Opera and sign into your Skool community normally.
- Open the lesson or post: Navigate to any Skool classroom lesson, community post, or course module with a video.
- Play the video: Start the video so the extension can detect the stream — it automatically identifies Loom, Vimeo, YouTube, Wistia, or Skool''s native player.
- Choose quality and download: Click the extension icon, select your preferred resolution, and download. The video saves as MP4 directly to your computer.

## Reviews

- Perfect for cohort replays (5/5): I grabbed every classroom replay before the cohort closed. Segment counters let me know how long each download would take. - Mariah Keene
- Works with private communities (4.9/5): My membership site locks lessons to members only. The downloader honoured my login automatically and the MP4 quality is flawless. - Theo Richter
- Offline study made simple (4.8/5): I travel often and need lessons offline. This keeps downloads private and never asks for extra credentials. - Ines Navarro

## Platform Support

### Browsers

- Chrome
- Edge
- Firefox
- Brave
- Opera
- Whale
- Yandex

### Operating Systems

- Windows
- macOS
- Linux

### Supported Content

- Skool Classroom Lessons
- Community Video Posts
- Course Modules
- About Pages

### Detected Video Platforms

- Skool Native (Mux)
- Loom
- Vimeo
- YouTube
- Wistia

### Not Supported

- Mobile browsers
- Safari
- DRM-protected content
- Live streams (wait for recording)

## Privacy and Permissions

Supported regions: Worldwide.

Limitations:
- DRM-protected content is not supported.
- Live streams cannot be downloaded — wait for the recording to be available.
- Mobile and Safari browsers are not supported.
- You must press play on the video before the extension can detect the stream.
- You must already have access to the content. It does not bypass paywalls or permissions.
- Available quality depends on what the source platform and course creator uploaded.
- Requires email sign-in (OTP) for trial activation.

Permissions:
- downloads: Saves the finished MP4 to your downloads folder and keeps the progress tracker accurate for each video.
- storage: Stores licence activation, download manager state, and preferences locally so the extension stays ready between sessions.
- activeTab: Detects video players and embedded content on the tab you are viewing so the extension can identify the video platform and source.
- tabs: Allows the download manager to track active downloads across tab changes and restores state when you return.
- scripting: Injects multi-platform video detectors to extract stream manifests, quality variants, and page data from Skool, Loom, Vimeo, YouTube, and Wistia.
- offscreen: Converts HLS stream segments into MP4 files in the background using an offscreen document, keeping your lesson tab responsive.

## FAQ

### How do I download a video from Skool?

Open any Skool classroom, community post, or course page with a video. Press play on the video, then click the extension icon in your toolbar. Select your preferred quality and click Download — it saves as MP4.

### What video platforms does this support?

The extension detects videos from Skool''s native player (Mux-based), Loom, Vimeo, YouTube, and Wistia — all of which are commonly used within Skool communities and courses.

### Does it work with private communities or paid cohorts?

Yes. The extension works with any Skool community or course you can access in your browser. If you can see and play the video, you can download it.

### How many free downloads do I get?

3 free trial downloads after signing in with your email. No credit card required. Purchase a license for unlimited downloads.

### Can I download multiple videos at once?

Yes. The extension supports a concurrent download queue with up to 3 simultaneous downloads, each with its own progress bar and speed tracking.

### Why isn''t the extension finding my video?

Press play on the video first. The extension needs the stream to start before detection works. If the video is embedded from an external platform, make sure the embed has loaded fully. Refresh the page if issues persist.

### Which browsers are supported?

Chrome, Edge, Firefox, Brave, Opera, Whale, and Yandex on Windows, macOS, and Linux desktops. Safari is not supported.

### What format are downloaded videos?

All videos are saved as standard MP4 files that play on any device or media player. HLS streams are converted to MP4 automatically in your browser.

### Is my data private?

Yes. Video processing happens entirely in your browser. Authentication uses secure OTP — no passwords stored. No video data is sent to external servers.

### Is this legal?

DISCLAIMER: We are not attorneys and do not offer legal advice. Laws vary by country and platform. For any legal question please consult a qualified legal professional.

We give you full control over download speeds because we believe users should decide how they use their software.

That said, here are a few widely accepted best practices for safe, responsible downloading:

- Only download content you created, own, or have explicit permission from the rights holder to access.

- Protect your personal data by respecting platform rules and rate limits with reasonable download speeds to avoid automated abuse systems putting your account at risk.

- Protect your privacy by using a reputable VPN for IP protection before initiating downloads — this is the VPN we recommend & use.', NULL, NULL, 0, 0, 1, 'draft', '2026-05-07', 243, 'legacy-json-migration-v1', 'serp-software-v1:e0f1f70aa986813cccd1f379a24bdc8dc27d546e67572d08fea1a4832c5a689e', '2026-07-13T00:00:00.000Z', 'a5eb394e52d3415fa5f2f85cb17757ac4b999cc1b02c80ce3736fab648ddd137', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_c435134518feee3cca2beac4', id, 0, 1 FROM categories WHERE site_id = 'serp.software' AND slug = 'video-downloaders';
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'logo', '/listing-logos/serpdownloaders.com/skool-downloader.png', 0);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'image', 'https://raw.githubusercontent.com/serpapps/.github/refs/heads/main/sites/skool-video-downloader.jpg', 0);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'image', 'https://raw.githubusercontent.com/serpapps/skool-downloader/main/screenshots/skool%20video%20downloader%201.png', 1);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'image', 'https://raw.githubusercontent.com/serpapps/skool-downloader/main/screenshots/skool%20video%20downloader%202.png', 2);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'image', 'https://raw.githubusercontent.com/serpapps/skool-downloader/main/screenshots/skool%20video%20downloader%203.png', 3);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'image', 'https://raw.githubusercontent.com/serpapps/skool-downloader/main/images/skool-video-downloader.gif', 4);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'Install browser extension', 'https://serp.ly/skool-video-downloader', 0);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'SERP Apps', 'https://apps.serp.co/skool-video-downloader', 1);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'GitHub repository', 'https://github.com/serpapps/skool-downloader', 2);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'SERP Extensions', 'https://extensions.serp.co/extensions/serp/skool-video-downloader/', 3);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'ExtensionHub', 'https://www.extensionhub.io/extensions/Skool-Video-Downloader-882', 4);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'SERP', 'https://serp.co/products/skool-video-downloader/reviews/', 5);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'SERP AI', 'https://serp.ai/products/skool-video-downloader/reviews/', 6);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'Browser Extensions', 'https://browserextensions.io/products/skool-video-downloader/', 7);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'Product Hunt', 'https://www.producthunt.com/products/skool-com-downloader', 8);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_c435134518feee3cca2beac4', 'Chrome Web Store', 'https://chromewebstore.google.com/detail/skool-video-downloader-by/adjbknblejbhfmcefnhgkdboanoboimj', 9);
INSERT INTO listings (id, site_id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES ('lst_d1467b2ae5e2f5974ace6b2b', 'serp.software', 'snapchat-video-downloader', 'Snapchat Video Downloader', 'Snapchat content disappears by design. Save Stories and Spotlight videos before they are gone for good.', 'https://serp.ly/snapchat-video-downloader', '## Overview

A Snapchat Story disappears in 24 hours. A trending Spotlight video can vanish anytime. Screenshots notify the sender, and screen recording kills the quality. Snapchat Video Downloader saves public Stories, Spotlight videos, and Snap Map content quietly and cleanly as high-quality video files.

Batch queue multiple videos in a single session to save everything before the clock runs out. Files are organized automatically by content type and date. Creators can back up published Stories, marketers can collect Spotlight trends for campaign inspiration, and anyone can preserve memorable moments from Snap Map.

Everything downloads privately to your device with nothing shared externally.

## Why It Exists

- Archive your own Snapchat Stories and Spotlight posts before they expire permanently
- Track Spotlight video trends for marketing research without worrying about content disappearing
- Save memorable public snaps and community stories from Snap Map locations
- Download ephemeral content in a single session using batch queuing instead of screen recording

## Key Features

- Download Snapchat Spotlight videos at the highest available quality
- Save public Story content from Snapchat''s web interface before expiration
- Capture Snap Map location-based videos and community stories
- Batch queue multiple Snapchat videos for sequential download
- Automatic file naming by content type, creator, and date
- Intercepts video stream URLs for direct high-quality saves
- Resume interrupted downloads with persistent queue state
- Works on Chrome, Firefox, Edge, and Opera browsers
- Local-only processing with no video data sent to external servers

## How It Works

- Open Snapchat Web Content: Navigate to Snapchat''s web interface to view Spotlight videos, public Stories, or Snap Map content in your browser.
- Detect and Select Videos: The extension intercepts video stream URLs from Snapchat''s web player automatically. Select one or more videos to download.
- Queue for Batch Download: Add multiple Snapchat videos to the download queue for sequential processing. Files are named by content type, creator, and date.
- Save at Highest Quality: Videos download at the highest available stream quality, matching the creator''s upload resolution. All files stay local on your device.

## Reviews

- Finally a real way to archive my own Snapchat content (5/5): I create content on Snapchat and always worried about losing my Stories after 24 hours. Now I archive everything I post as soon as it goes live. Way better than screen recording with quality loss. - Jordan Whitmore
- Changed how our team tracks Spotlight trends (4.9/5): Our marketing team monitors Spotlight trends for campaign inspiration. Being able to download trending videos instead of just screenshotting them has been invaluable for our creative briefings. - Priya Chakraborty
- Perfect for saving Snap Map travel memories (4.8/5): I travel a lot and love saving Snap Map community stories from places I visit. The batch queue makes it easy to grab a dozen videos from a location in one go before moving on. - Lucas Bergmann

## Platform Support

### Supported Browsers

- Google Chrome
- Mozilla Firefox
- Microsoft Edge
- Opera

### Supported Operating Systems

- Windows 10/11
- macOS 11+
- Ubuntu / Debian / Fedora Linux

### Supported Content

- Spotlight trending videos
- Public Story content
- Snap Map location-based videos
- Community stories
- Batch queue downloads

### Not Supported

- Private direct messages
- Friend-only stories
- Snapchat mobile app content
- AR lenses and filters
- Chat media

## Privacy and Permissions

Supported regions: Worldwide.

Limitations:
- Only works with publicly accessible content viewable through Snapchat''s web interface
- Cannot download private direct messages, friend-only stories, or login-restricted content
- Stories must be saved during their 24-hour availability window before expiration
- Snapchat web interface updates may temporarily affect functionality until an extension update
- Video quality depends on what the creator originally uploaded and Snapchat''s available streams
- Does not capture AR lens effects or interactive content elements

Permissions:
- activeTab: Required to detect Snapchat web player content and intercept video stream URLs on the currently active tab.
- downloads: Used to save video files directly to your local downloads directory.
- storage: Stores download queue state, file naming preferences, and settings locally in the browser.

## FAQ

### Can I save Snapchat Stories before they disappear?

Yes. The downloader works with public Story content accessible through Snapchat''s web interface. You can save Stories during their 24-hour window before they expire.

### Does it work with Snapchat Spotlight videos?

Yes. Spotlight videos that are publicly viewable through the web can be downloaded at the highest available quality.

### Can I download from Snap Map?

Yes. Public Snap Map content including location-based community stories and individual public snaps can be saved through the web interface.

### Does it download private snaps sent directly to me?

No. The downloader only works with publicly accessible content viewable through Snapchat''s web interface. It does not access private direct messages, friend-only stories, or any content behind login restrictions.

### What video quality can I expect?

The downloader captures the highest quality stream available from Snapchat''s web player, which is typically the same resolution the creator uploaded at.

### Is this legal?

DISCLAIMER: We are not attorneys and do not offer legal advice. Laws vary by country and platform. For any legal question please consult a qualified legal professional.

We give you full control over download speeds because we believe users should decide how they use their software.

That said, here are a few widely accepted best practices for safe, responsible downloading:

- Only download content you created, own, or have explicit permission from the rights holder to access.

- Protect your personal data by respecting platform rules and rate limits with reasonable download speeds to avoid automated abuse systems putting your account at risk.

- Protect your privacy by using a reputable VPN for IP protection before initiating downloads — this is the VPN we recommend & use.', NULL, NULL, 0, 0, 1, 'draft', '2026-05-07', 244, 'legacy-json-migration-v1', 'serp-software-v1:e0f1f70aa986813cccd1f379a24bdc8dc27d546e67572d08fea1a4832c5a689e', '2026-07-13T00:00:00.000Z', 'a9ebb00d95ba7894e53ae05579e91647d46e4353b9b9ffea9f75cdc1b8e35b81', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_d1467b2ae5e2f5974ace6b2b', id, 0, 1 FROM categories WHERE site_id = 'serp.software' AND slug = 'video-downloaders';
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_d1467b2ae5e2f5974ace6b2b', 'image', 'https://raw.githubusercontent.com/serpapps/.github/refs/heads/main/sites/snapchat-video-downloader.jpg', 0);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_d1467b2ae5e2f5974ace6b2b', 'image', 'https://raw.githubusercontent.com/serpapps/snapchat-video-downloader/main/images/snapchat-downloader.gif', 1);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_d1467b2ae5e2f5974ace6b2b', 'image', 'https://raw.githubusercontent.com/serpapps/snapchat-video-downloader/main/images/snapchat-downloader.jpg', 2);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_d1467b2ae5e2f5974ace6b2b', 'image', 'https://raw.githubusercontent.com/serpapps/snapchat-video-downloader/main/images/snapchat-video-downloader.gif', 3);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_d1467b2ae5e2f5974ace6b2b', 'Install browser extension', 'https://serp.ly/snapchat-video-downloader', 0);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_d1467b2ae5e2f5974ace6b2b', 'SERP Apps', 'https://apps.serp.co/snapchat-video-downloader', 1);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_d1467b2ae5e2f5974ace6b2b', 'GitHub repository', 'https://github.com/serpapps/snapchat-video-downloader', 2);
INSERT INTO listings (id, site_id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES ('lst_b6a29ed3f0217a04c89da63c', 'serp.software', 'soundgasm-downloader', 'Soundgasm Downloader', 'Soundgasm has no download button. This extension adds one. Save audio tracks for offline listening with a single click.', 'https://serp.ly/soundgasm-downloader', '## Overview

Soundgasm has no download button on any track page. The only options are streaming online every time or manually extracting the audio source. Neither is practical.

Soundgasm Downloader fixes this instantly. Visit any Soundgasm track page, click the download button that appears, and the audio saves straight to your computer at original quality. The batch download pulls every track from a creator''s profile page in one go, sorted into folders by creator name.

No copying URLs into sketchy third-party sites, no digging through page source code. Clean, simple downloads with track titles and creator info kept intact. Everything runs privately in your browser.

## Why It Exists

- Save Soundgasm audio tracks for offline listening without copy-pasting URLs or inspecting page source.
- Batch download entire creator libraries in one operation instead of saving tracks individually.
- Preserve original audio quality and metadata so tracks stay organized and identifiable.
- Keep all downloads private with local-only processing and no external uploads.

## Key Features

- One-click audio downloads from any Soundgasm track page
- Batch downloading from creator profile pages and playlists
- Automatic metadata preservation including title, creator, and description
- Creator-based folder organization for downloaded audio files
- Download queue for managing multiple tracks without connection overload
- Original audio quality preservation without re-encoding or compression
- Automatic Soundgasm player detection on supported pages
- Cross-browser support for Chrome, Edge, Firefox, Brave, and Opera
- Progress tracking with download status indicators
- Duplicate detection to skip previously downloaded tracks

## Reviews

- Perfect for offline ASMR listening (5/5): I listen to a lot of ASMR content on Soundgasm and this extension makes saving tracks dead simple. One click and it''s on my phone for offline listening. The metadata preservation is a nice touch too. - Rachel Kim
- Batch downloads are a lifesaver (4.9/5): The batch download feature saved me hours. I had dozens of tracks to archive from a creator who was leaving the platform and got everything in one go with proper folder organization. - Connor Walsh
- Simple and gets the job done (4.8/5): Clean, simple, and reliable. No ads, no weird redirects, just downloads the audio file exactly as it was uploaded. The creator-based folders keep my library tidy. - Sofia Reyes

## Privacy and Permissions

Supported regions: Worldwide.

Permissions:
- downloads: Saves audio files to your device and manages the download queue for batch and single-track operations.
- activeTab: Detects Soundgasm audio players and injects download controls only on the tab you are actively viewing.
- storage: Stores download history, duplicate detection data, and user preferences locally in your browser.
- notifications: Notifies you when batch downloads complete or if a download encounters an error.

## FAQ

### How do I download audio from Soundgasm?

Install the extension, navigate to any Soundgasm audio page, and click the download button that appears near the player. The audio file is saved directly to your computer with its original quality and metadata intact.

### Can I download all tracks from a creator''s profile at once?

Yes. When you visit a Soundgasm creator profile page, the extension offers a batch download option that queues all available tracks and saves them into a folder named after the creator.

### What audio format are files saved in?

Files are saved in the original format hosted on Soundgasm, typically MP3. The extension does not re-encode or compress the audio, so you get the same quality the creator uploaded.

### Does this preserve track titles and creator information?

Yes. The extension extracts available metadata including track title, creator name, and description, and uses this information for file naming and folder organization.

### Is there a limit on how many tracks I can download?

There are no artificial limits imposed by the extension. You can download as many tracks as your storage allows. The built-in queue manages multiple downloads so they complete reliably.

### Which browsers are supported?

The extension works on Chrome, Edge, Firefox, Brave, and Opera on Windows, macOS, and Linux. Safari and mobile browsers are not currently supported.

### Is this legal?

DISCLAIMER: We are not attorneys and do not offer legal advice. Laws vary by country and platform. For any legal question please consult a qualified legal professional.

We give you full control over download speeds because we believe users should decide how they use their software.

That said, here are a few widely accepted best practices for safe, responsible downloading:

- Only download content you created, own, or have explicit permission from the rights holder to access.

- Protect your personal data by respecting platform rules and rate limits with reasonable download speeds to avoid automated abuse systems putting your account at risk.

- Protect your privacy by using a reputable VPN for IP protection before initiating downloads — this is the VPN we recommend & use.', NULL, NULL, 0, 0, 1, 'draft', '2026-05-07', 245, 'legacy-json-migration-v1', 'serp-software-v1:e0f1f70aa986813cccd1f379a24bdc8dc27d546e67572d08fea1a4832c5a689e', '2026-07-13T00:00:00.000Z', '875da1ef207a7aa288e30470829dfe4f7a5c6e27cc24bc6dc19f11ab48b4f07b', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_b6a29ed3f0217a04c89da63c', id, 0, 1 FROM categories WHERE site_id = 'serp.software' AND slug = 'video-downloaders';
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_b6a29ed3f0217a04c89da63c', 'image', 'https://raw.githubusercontent.com/serpapps/.github/refs/heads/main/sites/soundgasm-downloader.jpg', 0);
INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_b6a29ed3f0217a04c89da63c', 'image', 'https://raw.githubusercontent.com/serpapps/soundgasm-downloader/main/images/soundgasm-downloader.gif', 1);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_b6a29ed3f0217a04c89da63c', 'Install browser extension', 'https://serp.ly/soundgasm-downloader', 0);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_b6a29ed3f0217a04c89da63c', 'SERP Apps', 'https://apps.serp.co/soundgasm-downloader', 1);
INSERT INTO listing_resource_links (listing_id, label, url, sort_order) VALUES ('lst_b6a29ed3f0217a04c89da63c', 'GitHub repository', 'https://github.com/serpapps/soundgasm-downloader', 2);
