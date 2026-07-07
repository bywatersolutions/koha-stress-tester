#!/usr/bin/perl

# analyze-koha-logs.pl - Extract a workload model from Koha OPAC Apache access logs
#
# Reads Apache access logs (combined or vhost_combined format, plain or
# gzipped) and produces:
#
#   1. A calibration JSON (--out) describing arrival rates, endpoint mix,
#      and session behavior (think times, searches per session, click-through
#      rate). Feed this to the k6 scripts via CALIBRATION_FILE.
#   2. A weighted search-terms JSON (--terms) extracted from opac-search.pl
#      'q=' parameters. Feed this to the k6 scripts via SEARCH_TERMS_FILE.
#
# The same tool is used to validate a load test: run it on the staging
# server's access log captured during the test and diff against the
# production calibration with --compare.
#
# Classification rules:
#   - Static assets (excluded from sessions, counted in raw req/s):
#     paths under /opac-tmpl/ or /intranet-tmpl/, or common asset extensions.
#   - Bots (excluded everywhere, percentage reported): matched by User-Agent.
#   - A "search" is a request to opac-search.pl with a non-empty 'q' param
#     and no 'offset' (or offset=0). The same with offset > 0 is pagination,
#     reported separately as paging_rate (paginated pages per search).
#   - A "detail view" is a request to opac-detail.pl.
#   - Sessions are reconstructed per client IP + User-Agent with an idle
#     timeout (--session-timeout, default 1800s). Think times are the gaps
#     between consecutive page requests within a session.
#   - If a bare integer follows the User-Agent field it is treated as an
#     Apache %D response time (microseconds vs milliseconds auto-detected,
#     override with --time-format).
#
# Privacy note: real patron queries can contain PII (names, card numbers
# typed into the wrong box). Treat the --terms output like log data - keep
# it out of version control and delete it when the testing engagement ends.
#
# Usage:
#   analyze-koha-logs.pl [options] access.log [access.log.2.gz ...]
#
#   --from 'YYYY-MM-DD HH:MM'   only count requests at/after this local time
#   --to   'YYYY-MM-DD HH:MM'   only count requests before this local time
#   --out FILE                  calibration JSON output (default: stdout)
#   --terms FILE                weighted search-terms JSON output
#   --top-terms N               cap the term list (default 10000)
#   --min-term-count N          drop terms seen fewer than N times (default 2)
#   --session-timeout SECONDS   session idle timeout (default 1800)
#   --extra-terms FILE          merge extra terms, one "weight<TAB>term" per line
#                               (e.g. from the Koha search_history SQL)
#   --include-bots              disable the bot filter (debugging)
#   --time-format auto|us|ms    unit of the trailing %D field (default auto)
#   --compare FILE              print deltas vs another calibration JSON
#   --help                      this help

use strict;
use warnings;
use Getopt::Long;
use Time::Local qw(timegm);
use IO::Uncompress::Gunzip qw($GunzipError);
use JSON::PP;
use List::Util qw(sum);
use POSIX qw(strftime);

my %opt = (
    'top-terms'       => 10000,
    'min-term-count'  => 2,
    'session-timeout' => 1800,
    'time-format'     => 'auto',
);
GetOptions(
    \%opt,
    'from=s', 'to=s', 'out=s', 'terms=s',
    'top-terms=i', 'min-term-count=i', 'session-timeout=i',
    'extra-terms=s', 'include-bots', 'time-format=s', 'compare=s',
    'help',
) or die "Bad options; try --help\n";

if ( $opt{help} || !@ARGV ) {
    # Print the usage block from the comment header above
    open my $self_fh, '<', $0 or die "Can't read $0: $!\n";
    my $in_usage = 0;
    while ( my $line = <$self_fh> ) {
        $in_usage = 1 if $line =~ /^# Usage:/;
        last if $in_usage && $line !~ /^#/;
        print STDERR ( $line =~ s/^# ?//r ) if $in_usage;
    }
    close $self_fh;
    exit( $opt{help} ? 0 : 1 );
}

my $SESSION_TIMEOUT = $opt{'session-timeout'};

# Normalize --from/--to to sortable "YYYY-MM-DD HH:MM:SS" strings compared
# against each request's log-local timestamp
my $FROM = $opt{from} ? normalize_window_time( $opt{from}, '00' ) : undef;
my $TO   = $opt{to}   ? normalize_window_time( $opt{to},   '00' ) : undef;

sub normalize_window_time {
    my ( $t, $pad_sec ) = @_;
    if ( $t =~ /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/ ) {
        return "$1 $2:$3:" . ( defined $4 ? $4 : $pad_sec );
    }
    die "Can't parse time '$t' (expected 'YYYY-MM-DD HH:MM')\n";
}

# ------------------------------------------------------------
# Log line parsing
# ------------------------------------------------------------

# Apache combined format, optionally followed by a bare %D integer
my $LINE_RE = qr/^
    (\S+)\s+                 # 1 client IP
    \S+\s+\S+\s+             # ident, remote user
    \[([^\]]+)\]\s+          # 2 timestamp
    "([^"]*)"\s+             # 3 request line
    (\d{3})\s+               # 4 status
    (?:\d+|-)                # bytes
    (?:\s+"([^"]*)")?        # 5 referer
    (?:\s+"([^"]*)")?        # 6 user agent
    (?:\s+(\d+))?            # 7 optional %D response time
    \s*$
/x;

my %MONTH = (
    Jan => 0, Feb => 1, Mar => 2, Apr => 3, May => 4,  Jun => 5,
    Jul => 6, Aug => 7, Sep => 8, Oct => 9, Nov => 10, Dec => 11,
);

# Returns (epoch, "YYYY-MM-DD HH:MM:SS" in log-local time) or empty list
sub parse_timestamp {
    my ($t) = @_;
    return unless $t =~ m{^(\d{2})/(\w{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})$};
    my ( $day, $mon_name, $year, $h, $m, $s, $sign, $oh, $om ) = ( $1, $2, $3, $4, $5, $6, $7, $8, $9 );
    my $mon = $MONTH{$mon_name};
    return unless defined $mon;
    my $epoch = eval { timegm( $s, $m, $h, $day, $mon, $year ) };
    return unless defined $epoch;
    my $offset = ( $oh * 3600 + $om * 60 ) * ( $sign eq '-' ? -1 : 1 );
    return ( $epoch - $offset, sprintf( "%04d-%02d-%02d %02d:%02d:%02d", $year, $mon + 1, $day, $h, $m, $s ) );
}

my $BOT_RE = qr/
    bot|crawl|spider|slurp|archive|preview|facebookexternalhit|headless|
    phantom|python-requests|python-urllib|curl|wget|libwww|go-http-client|
    okhttp|java\/|scrapy|semrush|ahrefs|mj12|dotbot|petalbot|yandex|
    baiduspider|bingpreview|gptbot|ccbot|bytespider|claudebot|nagios|
    icinga|uptimerobot|pingdom|statuscake|monitor
/xi;

sub is_bot {
    my ($ua) = @_;
    return 1 if !defined $ua || $ua eq '' || $ua eq '-';
    return $ua =~ $BOT_RE ? 1 : 0;
}

sub is_static {
    my ($path) = @_;
    return 1 if $path =~ m{^/(?:opac-tmpl|intranet-tmpl)/};
    return 1 if $path =~ /\.(?:css|js|png|jpe?g|gif|ico|svg|woff2?|ttf|eot|map|webp)$/i;
    return 0;
}

sub endpoint_key {
    my ($path) = @_;
    return $1 if $path =~ m{^/cgi-bin/koha/(?:[^/?]+/)*([^/?]+\.pl)$};
    return $1 if $path =~ m{^(/[^/?]*(?:/[^/?]*)?)};
    return $path;
}

sub url_decode {
    my ($s) = @_;
    $s =~ tr/+/ /;
    $s =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/eg;
    utf8::decode($s);    # best effort; leaves bytes untouched if not valid UTF-8
    return $s;
}

sub normalize_term {
    my ($term) = @_;
    $term = lc $term;
    $term =~ s/\s+/ /g;
    $term =~ s/^\s+|\s+$//g;
    return if $term eq '' || length($term) > 100 || $term =~ /[[:cntrl:]]/;
    return $term;
}

# ------------------------------------------------------------
# Accumulators
# ------------------------------------------------------------
my ( $lines_total, $lines_parsed, $lines_skipped, $out_of_window ) = ( 0, 0, 0, 0 );
my ( $bot_requests, $requests, $page_requests )                    = ( 0, 0, 0 );
my ( $searches, $paging, $neg_gaps )                               = ( 0, 0, 0 );
my ( $min_epoch, $max_epoch );

my %per_minute;         # "YYYY-MM-DD HH:MM" -> { req, pages, searches, sessions_started }
my %endpoint_count;     # endpoint -> page request count
my %endpoint_rt;        # endpoint -> { raw_time_bin -> count }
my $rt_samples = 0;

my %terms;              # normalized term -> count

my %open_sessions;      # ip\0ua -> { last_ts, pages, searches, details_after, paging }
my $sessions_started = 0;

my %think_hist;         # int(seconds) -> count
my ( $think_n, $think_sum ) = ( 0, 0 );

my %closed;             # session aggregates
my %pages_hist;         # pages-per-session -> count
my %searches_hist;      # searches-per-session -> count

sub close_session {
    my ($s) = @_;
    $closed{count}++;
    $pages_hist{ $s->{pages} }++;
    $searches_hist{ $s->{searches} }++;
    if ( $s->{searches} > 0 ) {
        $closed{with_search}++;
        $closed{details_after} += $s->{details_after};
        $closed{clicked}++ if $s->{details_after} > 0;
    }
}

# ------------------------------------------------------------
# Main loop
# ------------------------------------------------------------
for my $file (@ARGV) {
    my $fh;
    if ( $file eq '-' ) {
        $fh = \*STDIN;
    } elsif ( $file =~ /\.gz$/ ) {
        $fh = IO::Uncompress::Gunzip->new($file)
            or die "Can't gunzip $file: $GunzipError\n";
    } else {
        open $fh, '<', $file or die "Can't open $file: $!\n";
    }

    while ( my $line = <$fh> ) {
        $lines_total++;
        chomp $line;

        my @f = $line =~ $LINE_RE;
        if ( !@f ) {
            # Retry as vhost_combined ("%v:%p %h ..."): drop the leading token
            ( my $shifted = $line ) =~ s/^\S+\s+//;
            @f = $shifted =~ $LINE_RE;
        }
        if ( !@f ) {
            $lines_skipped++;
            next;
        }
        $lines_parsed++;

        my ( $ip, $ts_raw, $request, $status, $referer, $ua, $rt ) = @f;
        my ( $epoch, $local ) = parse_timestamp($ts_raw);
        if ( !defined $epoch ) {
            $lines_skipped++;
            $lines_parsed--;
            next;
        }

        if ( ( $FROM && $local lt $FROM ) || ( $TO && $local ge $TO ) ) {
            $out_of_window++;
            next;
        }

        if ( !$opt{'include-bots'} && is_bot($ua) ) {
            $bot_requests++;
            next;
        }

        $requests++;
        $min_epoch = $epoch if !defined $min_epoch || $epoch < $min_epoch;
        $max_epoch = $epoch if !defined $max_epoch || $epoch > $max_epoch;

        my $minute = substr( $local, 0, 16 );
        $per_minute{$minute}{req}++;

        my ( $method, $target ) = split /\s+/, ( $request // '' );
        next unless defined $target && $target =~ m{^/};
        my ( $path, $query ) = split /\?/, $target, 2;

        next if is_static($path);

        # From here down: a "page" request
        $page_requests++;
        $per_minute{$minute}{pages}++;

        my $endpoint = endpoint_key($path);
        $endpoint_count{$endpoint}++;
        if ( defined $rt ) {
            $endpoint_rt{$endpoint}{ int($rt) }++;
            $rt_samples++;
        }

        # Classify the page
        my $kind = 'page';
        if ( $endpoint eq 'opac-search.pl' && defined $query ) {
            my ( @q, $offset );
            for my $pair ( split /[&;]/, $query ) {
                my ( $k, $v ) = split /=/, $pair, 2;
                next unless defined $k;
                $v = url_decode( $v // '' );
                push @q, $v if $k eq 'q' && $v ne '';
                $offset = $v if $k eq 'offset';
            }
            if (@q) {
                if ( defined $offset && $offset =~ /^\d+$/ && $offset > 0 ) {
                    $kind = 'paging';
                    $paging++;
                } else {
                    $kind = 'search';
                    $searches++;
                    $per_minute{$minute}{searches}++;
                    my $term = normalize_term( join ' ', @q );
                    $terms{$term}++ if defined $term;
                }
            }
        } elsif ( $endpoint eq 'opac-detail.pl' ) {
            $kind = 'detail';
        }

        # Session tracking
        my $key = $ip . "\0" . ( $ua // '' );
        my $s   = $open_sessions{$key};
        if ( $s && $epoch - $s->{last_ts} > $SESSION_TIMEOUT ) {
            close_session($s);
            $s = undef;
        }
        if ( !$s ) {
            $s = $open_sessions{$key} = { last_ts => $epoch, pages => 0, searches => 0, details_after => 0, paging => 0 };
            $sessions_started++;
            $per_minute{$minute}{sessions_started}++;
        } else {
            my $gap = $epoch - $s->{last_ts};
            if ( $gap < 0 ) {
                # Mildly out-of-order lines (buffered vhost logs)
                $gap = 0;
                $neg_gaps++;
            }
            $think_hist{ int($gap) }++;
            $think_n++;
            $think_sum += $gap;
            $s->{last_ts} = $epoch;
        }
        $s->{pages}++;
        if    ( $kind eq 'search' ) { $s->{searches}++ }
        elsif ( $kind eq 'paging' ) { $s->{paging}++ }
        elsif ( $kind eq 'detail' && $s->{searches} > 0 ) { $s->{details_after}++ }
    }
    close $fh unless $file eq '-';
}

close_session($_) for values %open_sessions;

# ------------------------------------------------------------
# Derived metrics
# ------------------------------------------------------------
sub round_to {
    my ( $v, $places ) = @_;
    return undef unless defined $v;
    return 0 + sprintf( "%.${places}f", $v );
}

# Nearest-rank quantiles from a { bin -> count } histogram
sub hist_quantiles {
    my ( $hist, $n, @fracs ) = @_;
    return unless $n;
    my @bins    = sort { $a <=> $b } keys %$hist;
    my @targets = map { int( $_ * ( $n - 1 ) + 0.5 ) } @fracs;
    my @out;
    my $cum = 0;
    my $ti  = 0;
    for my $b (@bins) {
        $cum += $hist->{$b};
        while ( $ti < @targets && $targets[$ti] <= $cum - 1 ) {
            push @out, $b;
            $ti++;
        }
        last if $ti >= @targets;
    }
    push @out, $bins[-1] while @out < @targets;
    return @out;
}

sub hist_mean {
    my ( $hist, $n ) = @_;
    return unless $n;
    my $total = 0;
    $total += $_ * $hist->{$_} for keys %$hist;
    return $total / $n;
}

my $duration_s;
if ( $FROM && $TO ) {
    my @from = $FROM =~ /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
    my @to   = $TO =~ /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
    $duration_s = timegm( $to[5], $to[4], $to[3], $to[2], $to[1] - 1, $to[0] )
        - timegm( $from[5], $from[4], $from[3], $from[2], $from[1] - 1, $from[0] );
} elsif ( defined $min_epoch ) {
    $duration_s = $max_epoch - $min_epoch;
}
$duration_s = 1 if !$duration_s || $duration_s < 1;

# Response-time unit: auto-detect microseconds vs milliseconds via overall p50
my $rt_unit = $opt{'time-format'};
if ( $rt_unit eq 'auto' && $rt_samples ) {
    my %all_rt;
    for my $ep ( keys %endpoint_rt ) {
        $all_rt{$_} += $endpoint_rt{$ep}{$_} for keys %{ $endpoint_rt{$ep} };
    }
    my ($p50) = hist_quantiles( \%all_rt, $rt_samples, 0.5 );
    $rt_unit = ( defined $p50 && $p50 >= 50_000 ) ? 'us' : 'ms';
}
my $rt_divisor = $rt_unit eq 'us' ? 1000 : 1;

# Endpoint mix: top 25 + other
my @endpoints;
{
    my @sorted = sort { $endpoint_count{$b} <=> $endpoint_count{$a} || $a cmp $b } keys %endpoint_count;
    my @top    = splice @sorted, 0, 25;
    for my $ep (@top) {
        my $row = {
            path  => $ep,
            count => $endpoint_count{$ep},
            pct   => $page_requests ? round_to( 100 * $endpoint_count{$ep} / $page_requests, 1 ) : undef,
        };
        if ( $endpoint_rt{$ep} ) {
            my $n = sum( values %{ $endpoint_rt{$ep} } );
            my ( $p50, $p95 ) = hist_quantiles( $endpoint_rt{$ep}, $n, 0.5, 0.95 );
            $row->{p50_ms} = round_to( $p50 / $rt_divisor, 0 );
            $row->{p95_ms} = round_to( $p95 / $rt_divisor, 0 );
        } else {
            $row->{p50_ms} = undef;
            $row->{p95_ms} = undef;
        }
        push @endpoints, $row;
    }
    if (@sorted) {
        my $rest = sum( map { $endpoint_count{$_} } @sorted );
        push @endpoints,
            {
            path   => 'other',
            count  => $rest,
            pct    => $page_requests ? round_to( 100 * $rest / $page_requests, 1 ) : undef,
            p50_ms => undef,
            p95_ms => undef,
            };
    }
}

my @minutes = map {
    my $m = $per_minute{$_};
    {
        m                => $_,
        req              => $m->{req} || 0,
        pages            => $m->{pages} || 0,
        searches         => $m->{searches} || 0,
        sessions_started => $m->{sessions_started} || 0,
    }
} sort keys %per_minute;

my $pages_n    = sum( values %pages_hist )    || 0;
my $searches_n = sum( values %searches_hist ) || 0;

my @think_q = hist_quantiles( \%think_hist, $think_n, map { $_ / 10 } 0 .. 10 );
my @pages_q    = hist_quantiles( \%pages_hist,    $pages_n,    0.5, 0.9, 0.99 );
my @searches_q = hist_quantiles( \%searches_hist, $searches_n, 0.5, 0.9 );

my $calibration = {
    v    => 1,
    meta => {
        generated        => strftime( "%Y-%m-%dT%H:%M:%SZ", gmtime ),
        window           => { from => $opt{from} || undef, to => $opt{to} || undef },
        files            => [@ARGV],
        lines_total      => $lines_total,
        lines_parsed     => $lines_parsed,
        lines_skipped    => $lines_skipped,
        out_of_window    => $out_of_window,
        bot_requests_pct => $lines_parsed ? round_to( 100 * $bot_requests / $lines_parsed, 1 ) : undef,
        negative_gaps    => $neg_gaps,
        has_response_times => $rt_samples ? JSON::PP::true : JSON::PP::false,
        response_time_unit  => $rt_samples ? $rt_unit : undef,
        session_timeout_s   => $SESSION_TIMEOUT,
    },
    arrival => {
        req_per_sec      => round_to( $requests / $duration_s,      4 ),
        page_req_per_sec => round_to( $page_requests / $duration_s, 4 ),
        searches_per_sec => round_to( $searches / $duration_s,      4 ),
        searches_per_hour => round_to( 3600 * $searches / $duration_s,         1 ),
        sessions_per_hour => round_to( 3600 * $sessions_started / $duration_s, 1 ),
        per_minute        => \@minutes,
    },
    endpoints => \@endpoints,
    sessions  => {
        count => $closed{count} || 0,
        pages_per_session => $pages_n
        ? {
            mean => round_to( hist_mean( \%pages_hist, $pages_n ), 1 ),
            p50  => $pages_q[0],
            p90  => $pages_q[1],
            p99  => $pages_q[2],
        }
        : undef,
        searches_per_session => $searches_n
        ? {
            mean => round_to( hist_mean( \%searches_hist, $searches_n ), 1 ),
            p50  => $searches_q[0],
            p90  => $searches_q[1],
        }
        : undef,
        click_through_rate => $closed{with_search}
        ? round_to( ( $closed{clicked} || 0 ) / $closed{with_search}, 3 )
        : undef,
        detail_views_per_search => $searches ? round_to( ( $closed{details_after} || 0 ) / $searches, 3 ) : undef,
        paging_rate             => $searches ? round_to( $paging / $searches, 3 )                         : undef,
        think_time_s            => $think_n
        ? {
            mean      => round_to( $think_sum / $think_n, 1 ),
            quantiles => \@think_q,
        }
        : undef,
    },
};

# ------------------------------------------------------------
# Output
# ------------------------------------------------------------
my $json = JSON::PP->new->utf8->canonical->pretty;

if ( $opt{out} && $opt{out} ne '-' ) {
    open my $out_fh, '>', $opt{out} or die "Can't write $opt{out}: $!\n";
    print {$out_fh} $json->encode($calibration);
    close $out_fh;
} else {
    print $json->encode($calibration);
}

if ( $opt{terms} ) {
    if ( $opt{'extra-terms'} ) {
        open my $extra_fh, '<', $opt{'extra-terms'} or die "Can't open $opt{'extra-terms'}: $!\n";
        while ( my $line = <$extra_fh> ) {
            chomp $line;
            my ( $w, $t ) = split /\t/, $line, 2;
            next unless defined $t && $w && $w =~ /^\d+$/;
            utf8::decode($t);
            $t = normalize_term($t);
            $terms{$t} += $w if defined $t;
        }
        close $extra_fh;
    }

    my @term_list =
        grep { $terms{$_} >= $opt{'min-term-count'} }
        sort { $terms{$b} <=> $terms{$a} || $a cmp $b } keys %terms;
    splice @term_list, $opt{'top-terms'} if @term_list > $opt{'top-terms'};

    my $terms_doc = {
        v             => 1,
        generated     => strftime( "%Y-%m-%dT%H:%M:%SZ", gmtime ),
        source_window => {
            from => $opt{from} || undef,
            to   => $opt{to}   || undef,
        },
        total_weight => sum( map { $terms{$_} } @term_list ) || 0,
        terms        => [ map { { t => $_, w => $terms{$_} } } @term_list ],
    };
    open my $terms_fh, '>', $opt{terms} or die "Can't write $opt{terms}: $!\n";
    print {$terms_fh} $json->encode($terms_doc);
    close $terms_fh;
}

# ------------------------------------------------------------
# STDERR summary
# ------------------------------------------------------------
sub say_err { print STDERR @_, "\n" }

say_err "========================================";
say_err "Files:          @ARGV";
say_err "Lines:          $lines_total total, $lines_parsed parsed, $lines_skipped skipped, $out_of_window outside window";
say_err sprintf( "Bot requests:   %s%%", $calibration->{meta}{bot_requests_pct} // 'n/a' );
say_err sprintf( "Window:         %s -> %s (%ds)", $opt{from} || 'log start', $opt{to} || 'log end', $duration_s );
say_err sprintf(
    "Rates:          %.3f req/s, %.3f pages/s, %.1f searches/hr, %.1f sessions/hr",
    $requests / $duration_s, $page_requests / $duration_s,
    3600 * $searches / $duration_s, 3600 * $sessions_started / $duration_s
);
if (@minutes) {
    my ($peak) = sort { $b->{req} <=> $a->{req} } @minutes;
    say_err "Peak minute:    $peak->{m} ($peak->{req} req, $peak->{searches} searches)";
}
say_err "Sessions:       " . ( $closed{count} || 0 ) . " (CTR " . ( $calibration->{sessions}{click_through_rate} // 'n/a' ) . ", paging_rate " . ( $calibration->{sessions}{paging_rate} // 'n/a' ) . ")";
if ($think_n) {
    say_err "Think time:     mean " . round_to( $think_sum / $think_n, 1 ) . "s, p50 $think_q[5]s, p90 $think_q[9]s";
}
say_err "Top endpoints:";
for my $ep ( @endpoints[ 0 .. ( $#endpoints > 9 ? 9 : $#endpoints ) ] ) {
    say_err sprintf( "  %6d  %5.1f%%  %s", $ep->{count}, $ep->{pct} // 0, $ep->{path} );
}
if (%terms) {
    my @top = ( sort { $terms{$b} <=> $terms{$a} || $a cmp $b } keys %terms )[ 0 .. 9 ];
    say_err "Top search terms:";
    for my $t ( grep { defined } @top ) {
        my $shown = $t;
        utf8::encode($shown);
        say_err sprintf( "  %6d  %s", $terms{$t}, $shown );
    }
}
say_err "========================================";

# ------------------------------------------------------------
# --compare: print deltas vs another calibration JSON
# ------------------------------------------------------------
if ( $opt{compare} ) {
    open my $cmp_fh, '<', $opt{compare} or die "Can't open $opt{compare}: $!\n";
    my $other = do { local $/; JSON::PP->new->utf8->decode(<$cmp_fh>) };
    close $cmp_fh;

    my @metrics = (
        [ 'req/s',              sub { $_[0]->{arrival}{req_per_sec} } ],
        [ 'pages/s',            sub { $_[0]->{arrival}{page_req_per_sec} } ],
        [ 'searches/hr',        sub { $_[0]->{arrival}{searches_per_hour} } ],
        [ 'sessions/hr',        sub { $_[0]->{arrival}{sessions_per_hour} } ],
        [ 'click-through rate', sub { $_[0]->{sessions}{click_through_rate} } ],
        [ 'details/search',     sub { $_[0]->{sessions}{detail_views_per_search} } ],
        [ 'paging rate',        sub { $_[0]->{sessions}{paging_rate} } ],
        [ 'think mean (s)',     sub { $_[0]->{sessions}{think_time_s} && $_[0]->{sessions}{think_time_s}{mean} } ],
        [ 'think p50 (s)',      sub { $_[0]->{sessions}{think_time_s} && $_[0]->{sessions}{think_time_s}{quantiles}[5] } ],
    );

    say_err "";
    say_err "Comparison vs $opt{compare}:";
    say_err sprintf( "  %-20s %12s %12s %10s", 'metric', 'this', 'other', 'delta' );
    for my $m (@metrics) {
        my ( $label, $get ) = @$m;
        my $a = $get->($calibration);
        my $b = $get->($other);
        my $delta =
              ( defined $a && defined $b && $b != 0 )
            ? sprintf( "%+.1f%%", 100 * ( $a - $b ) / $b )
            : 'n/a';
        say_err sprintf( "  %-20s %12s %12s %10s", $label, $a // 'n/a', $b // 'n/a', $delta );
    }

    my %other_pct = map { $_->{path} => $_->{pct} } @{ $other->{endpoints} || [] };
    my %this_pct  = map { $_->{path} => $_->{pct} } @endpoints;
    my %union     = ( %other_pct, %this_pct );
    my @union     = ( sort { ( $union{$b} // 0 ) <=> ( $union{$a} // 0 ) } keys %union )[ 0 .. 9 ];
    say_err "  Endpoint mix (% of page requests):";
    for my $ep ( grep { defined } @union ) {
        say_err sprintf(
            "  %-30s %10s %10s", $ep,
            defined $this_pct{$ep}  ? "$this_pct{$ep}%"  : '-',
            defined $other_pct{$ep} ? "$other_pct{$ep}%" : '-'
        );
    }
}
