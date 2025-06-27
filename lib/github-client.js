const fetch = require("node-fetch");
require("dotenv").config();

// Work repository classification
function getProjectType(repoName) {
  return repoName.startsWith("cortexapps/") ? "Work" : "Personal";
}

class GitHubClient {
  constructor() {
    this.token = process.env.GITHUB_TOKEN;
    this.username = process.env.GITHUB_USERNAME;
    this.baseUrl = "https://api.github.com";
  }

  async makeRequest(url, options = {}) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...options.headers,
        },
      });

      if (!response.ok) {
        throw new Error(
          `GitHub API error: ${response.status} ${response.statusText}`
        );
      }

      return await response.json();
    } catch (error) {
      console.error("❌ GitHub API request failed:", error.message);
      throw error;
    }
  }

  async testConnection() {
    try {
      const user = await this.makeRequest(`${this.baseUrl}/user`);
      console.log("✅ GitHub connection successful!");
      console.log(`👤 User: ${user.name} (@${user.login})`);
      return true;
    } catch (error) {
      console.error("❌ GitHub connection failed:", error.message);
      return false;
    }
  }

  async getUserEvents(startDate, endDate) {
    try {
      // Adjust for EST timezone when searching
      const startDateStr = new Date(startDate.getTime() + 5 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
      const endDateStr = new Date(endDate.getTime() + 5 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      console.log(
        `🔄 Searching for commits authored by ${
          this.username
        } from ${startDate.toDateString()} to ${endDate.toDateString()}`
      );

      // Search for commits you authored in the date range
      const searchQuery = `author:${this.username} committer-date:${startDateStr}..${endDateStr}`;
      console.log(`🔍 Debug: Search query: ${searchQuery}`);
      const searchResults = await this.makeRequest(
        `${this.baseUrl}/search/commits?q=${encodeURIComponent(
          searchQuery
        )}&per_page=100&sort=committer-date&order=desc`
      );

      // Debug: Log what we found
      console.log(
        `🔍 Debug: Total authored commits found: ${searchResults.total_count}`
      );
      console.log(
        `🔍 Debug: Commits returned: ${searchResults.items?.length || 0}`
      );

      // Show repositories found
      const repoNames = [
        ...new Set(
          (searchResults.items || []).map((item) => item.repository.full_name)
        ),
      ];
      console.log(
        `🔍 Debug: Repositories with your commits: ${repoNames.join(", ")}`
      );

      const searchCommits = searchResults.items || [];
      console.log(`📊 Found ${searchCommits.length} commits from search API`);

      // Get additional commits from work repositories
      const workCommits = await this.getWorkRepoCommits(startDate, endDate);

      // Merge and deduplicate by SHA
      const allCommits = [...searchCommits];
      const existingShas = new Set(searchCommits.map((c) => c.sha));

      for (const workCommit of workCommits) {
        if (!existingShas.has(workCommit.sha)) {
          allCommits.push(workCommit);
          existingShas.add(workCommit.sha);
        }
      }

      console.log(
        `📊 Total unique commits (search + work repos): ${allCommits.length}`
      );
      return allCommits;
    } catch (error) {
      console.error("❌ Error searching for authored commits:", error.message);
      return [];
    }
  }

  async getCommitDetails(repoFullName, sha) {
    try {
      const commit = await this.makeRequest(
        `${this.baseUrl}/repos/${repoFullName}/commits/${sha}`
      );

      // First, expand work commits if they're squashed PRs
      const expandedCommits = await this.expandWorkCommitIfSquashed(
        repoFullName,
        {
          sha: commit.sha,
          message: commit.commit.message,
          date: commit.commit.author.date,
          stats: commit.stats,
          files: commit.files || [],
          author: commit.commit.author,
        }
      );

      // For work repos, we might have expanded multiple commits
      // For personal repos, we'll have the single commit with PR info
      if (
        expandedCommits.length === 1 &&
        repoFullName.startsWith("cortexapps/")
      ) {
        // Single work commit, get PR info
        const prs = await this.getCommitPRs(repoFullName, sha);
        const prTitles =
          prs.length > 0
            ? prs.map((pr) => `${pr.title} (#${pr.number})`).join(", ")
            : "";

        expandedCommits[0].prs = prs;
        expandedCommits[0].prTitles = prTitles;
      } else if (expandedCommits.length === 1) {
        // Personal repo commit, get PR info if any
        const prs = await this.getCommitPRs(repoFullName, sha);
        const prTitles =
          prs.length > 0
            ? prs.map((pr) => `${pr.title} (#${pr.number})`).join(", ")
            : "";

        expandedCommits[0].prs = prs;
        expandedCommits[0].prTitles = prTitles;
      }

      return expandedCommits;
    } catch (error) {
      console.error(`❌ Error fetching commit ${sha}:`, error.message);
      return null;
    }
  }

  async getCommitPRs(repoFullName, sha) {
    try {
      // Get PRs associated with this commit
      const prs = await this.makeRequest(
        `${this.baseUrl}/repos/${repoFullName}/commits/${sha}/pulls`
      );
      return prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.html_url,
      }));
    } catch (error) {
      console.error(`❌ Error fetching PRs for commit ${sha}:`, error.message);
      return [];
    }
  }

  async getWorkRepoCommits(startDate, endDate) {
    try {
      const startDateStr = startDate.toISOString();
      const endDateStr = endDate.toISOString();

      console.log(
        `🔄 Fetching work repo commits from ${startDate.toDateString()} to ${endDate.toDateString()}`
      );

      // Get all repositories user has access to
      const repos = await this.makeRequest(
        `${this.baseUrl}/user/repos?per_page=100&type=all`
      );

      // Filter for work repositories (cortexapps/*)
      const workRepos = repos.filter((repo) =>
        repo.full_name.startsWith("cortexapps/")
      );
      console.log(`🔍 Found ${workRepos.length} work repositories`);

      const allWorkCommits = [];

      // Fetch commits from each work repo
      for (const repo of workRepos) {
        try {
          const commits = await this.makeRequest(
            `${this.baseUrl}/repos/${repo.full_name}/commits?author=${this.username}&since=${startDateStr}&until=${endDateStr}&per_page=100`
          );

          if (commits.length > 0) {
            console.log(
              `🔍 Found ${commits.length} commits in ${repo.full_name}`
            );

            // Transform to match search API format
            const transformedCommits = commits.map((commit) => ({
              sha: commit.sha,
              commit: commit.commit,
              repository: {
                full_name: repo.full_name,
                name: repo.name,
              },
            }));

            allWorkCommits.push(...transformedCommits);
          }
        } catch (error) {
          // Skip repos we don't have access to (409 Conflict)
          if (error.message.includes("409")) {
            console.log(`⚠️  Skipping ${repo.full_name} (no access)`);
          } else {
            console.error(
              `❌ Error fetching commits from ${repo.full_name}:`,
              error.message
            );
          }
        }
      }

      console.log(`📊 Found ${allWorkCommits.length} total work commits`);
      return allWorkCommits;
    } catch (error) {
      console.error("❌ Error fetching work repo commits:", error.message);
      return [];
    }
  }

  async expandWorkCommitIfSquashed(repoFullName, commit) {
    // Only expand commits from work repositories
    if (!repoFullName.startsWith("cortexapps/")) {
      return [commit]; // Return single commit for personal repos
    }

    try {
      console.log(
        `🔍 Checking if ${commit.sha.substring(0, 7)} is a squashed commit...`
      );

      // Check if this commit is part of any PRs
      const prs = await this.makeRequest(
        `${this.baseUrl}/repos/${repoFullName}/commits/${commit.sha}/pulls`
      );

      if (prs.length === 0) {
        // Not part of a PR, return original commit
        return [commit];
      }

      const pr = prs[0]; // Take the first PR
      console.log(`🔍 Found PR #${pr.number}: ${pr.title}`);

      // Get all commits from the PR
      const prCommits = await this.makeRequest(
        `${this.baseUrl}/repos/${repoFullName}/pulls/${pr.number}/commits`
      );

      if (prCommits.length <= 1) {
        // Only one commit in PR, return original
        return [commit];
      }

      console.log(
        `✨ Expanding squashed commit into ${prCommits.length} individual commits`
      );

      // Transform PR commits to match our expected format
      return prCommits.map((prCommit) => ({
        sha: prCommit.sha,
        message: prCommit.commit.message,
        date: prCommit.commit.author.date,
        stats: null, // We'll fetch these individually if needed
        files: [],
        author: prCommit.commit.author,
        prs: [
          {
            // Keep the PR info
            number: pr.number,
            title: pr.title,
            state: pr.state,
            url: pr.html_url,
          },
        ],
        prTitles: `${pr.title} (#${pr.number})`,
      }));
    } catch (error) {
      console.error(`❌ Error expanding commit ${commit.sha}:`, error.message);
      return [commit]; // Return original commit on error
    }
  }

  async getActivities(startDate, endDate) {
    try {
      // Get GitHub events (replaces Strava activities)
      const commits = await this.getUserEvents(startDate, endDate);

      // Process events into daily activities grouped by repository
      const activities = await this.processEventsIntoActivities(
        commits,
        startDate,
        endDate
      );

      console.log(`🔨 Found ${activities.length} repositories with activity`);
      return activities;
    } catch (error) {
      console.error("❌ Error getting GitHub activities:", error.message);
      return [];
    }
  }

  async processEventsIntoActivities(commits, startDate, endDate) {
    const repoGroups = {};

    for (const commitItem of commits) {
      const commit = commitItem.commit;
      const commitDate = new Date(commit.committer.date);
      // Convert UTC to Eastern Time (handles EST/EDT automatically)
      const estDate = new Date(
        commitDate.toLocaleString("en-US", { timeZone: "America/New_York" })
      );
      const dateKey = estDate.toISOString().split("T")[0]; // YYYY-MM-DD
      const repoName = commitItem.repository.full_name;
      const groupKey = `${repoName}-${dateKey}`;

      if (!repoGroups[groupKey]) {
        repoGroups[groupKey] = {
          repository: repoName,
          date: dateKey,
          commits: [],
          eventDate: commitDate,
        };
      }

      // Get detailed commit information (may return multiple commits for work PRs)
      const commitDetails = await this.getCommitDetails(
        repoName,
        commitItem.sha
      );
      if (commitDetails) {
        if (Array.isArray(commitDetails)) {
          // Multiple commits from expanded PR
          repoGroups[groupKey].commits.push(...commitDetails);
        } else {
          // Single commit
          repoGroups[groupKey].commits.push(commitDetails);
        }
      }
    }

    // Convert groups to activities format (matching previous pattern)
    return Object.values(repoGroups)
      .filter((group) => group.commits.length > 0)
      .map((group) => this.convertToActivity(group));
  }

  convertToActivity(repoGroup) {
    // Calculate aggregated stats
    const totalStats = repoGroup.commits.reduce(
      (acc, commit) => ({
        additions: acc.additions + (commit.stats?.additions || 0),
        deletions: acc.deletions + (commit.stats?.deletions || 0),
        total: acc.total + (commit.stats?.total || 0),
      }),
      { additions: 0, deletions: 0, total: 0 }
    );

    // Get unique files
    const allFiles = repoGroup.commits.flatMap((commit) =>
      (commit.files || []).map((file) => file.filename)
    );
    const uniqueFiles = [...new Set(allFiles)];

    // Format commit messages (CSV style)
    const commitMessages = repoGroup.commits
      .flatMap((commit) =>
        commit.allCommitMessages && commit.allCommitMessages.length > 0
          ? commit.allCommitMessages.map((msg, idx) => {
              const time = new Date(commit.date)
                .toISOString()
                .split("T")[1]
                .split(".")[0];
              return `${msg} (${time})`;
            })
          : [
              (() => {
                const time = new Date(commit.date)
                  .toISOString()
                  .split("T")[1]
                  .split(".")[0];
                return `${commit.message.split("\n")[0]} (${time})`;
              })(),
            ]
      )
      .join(", ");

    // Format PR titles (CSV style) - deduplicated
    const prTitles = [
      ...new Set(
        repoGroup.commits
          .filter((commit) => commit.prTitles)
          .map((commit) => commit.prTitles)
      ),
    ].join(", ");

    // Get time range
    const commitTimes = repoGroup.commits.map((c) => new Date(c.date));
    const startTime =
      commitTimes.length > 0
        ? new Date(Math.min(...commitTimes))
        : repoGroup.eventDate;
    const endTime =
      commitTimes.length > 0
        ? new Date(Math.max(...commitTimes))
        : repoGroup.eventDate;

    // Convert to activity format (matching Strava structure)
    return {
      name: repoGroup.repository,
      type: "Development",
      start_date: startTime.toISOString(),
      start_date_local: startTime.toISOString(),
      id: `${repoGroup.repository}-${repoGroup.date}`.replace(
        /[^a-zA-Z0-9-]/g,
        "-"
      ),

      // GitHub-specific data
      repository: repoGroup.repository,
      projectType: getProjectType(repoGroup.repository),
      date: repoGroup.date,
      commitsCount: repoGroup.commits.length,
      commitMessages: commitMessages,
      prTitles: prTitles,
      filesChanged: uniqueFiles.length,
      filesChangedList: uniqueFiles.join(", "),
      totalLinesAdded: totalStats.additions,
      totalLinesDeleted: totalStats.deletions,
      totalChanges: totalStats.total,

      // Times for calendar
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration: Math.max(1, Math.round((endTime - startTime) / (1000 * 60))), // minutes, minimum 1
    };
  }
}

module.exports = GitHubClient;
